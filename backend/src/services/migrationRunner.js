import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeSSH } from "node-ssh";
import { getSourceServer, getTargetServer, resolvePrivateKey } from "../config/servers.js";
import { appendLog, getJob, updateJob } from "./jobsStore.js";

const DRY_RUN = process.env.DRY_RUN !== "false";
const execFileAsync = promisify(execFile);

const stepPlan = [
  { progress: 10, message: "Validacao inicial dos servidores..." },
  { progress: 25, message: "Gerando mongodump na origem..." },
  { progress: 40, message: "Comprimindo dump..." },
  { progress: 60, message: "Transferindo arquivo entre servidores..." },
  { progress: 75, message: "Extraindo dump no destino..." },
  { progress: 90, message: "Executando mongorestore..." },
  { progress: 98, message: "Limpando arquivos temporarios..." },
];

function mapErrorMessage(rawMessage) {
  const msg = (rawMessage || "").toLowerCase();
  if (msg.includes("senha sudo invalida")) return "Falha: Senha sudo invalida no servidor destino.";
  if (msg.includes("server selection timed out")) return "Falha: Timeout ao conectar no MongoDB (server selection timeout).";
  if (msg.includes("no space left on device")) return "Falha: O servidor nao tem espaco em disco suficiente.";
  if (msg.includes("authentication failed")) return "Falha: Problema com as chaves de acesso ao servidor.";
  if (msg.includes("falha de autenticacao ssh")) return "Falha: SSH recusou autenticacao (chave/agent).";
  if (msg.includes("no such file")) return "Falha: Arquivo de dump nao encontrado no caminho remoto esperado.";
  if (msg.includes("timed out") || msg.includes("timeout")) return `Falha: Timeout durante operacao remota. Detalhe: ${rawMessage}`;
  return `Falha: ${rawMessage || "erro inesperado durante a migracao."}`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildAuthCandidates(server) {
  const candidates = [];
  const explicitKey = resolvePrivateKey(server);

  if (explicitKey) {
    candidates.push({
      label: `privateKeyPath:${explicitKey}`,
      config: { privateKeyPath: explicitKey },
    });
  }

  if (process.env.SSH_AUTH_SOCK) {
    candidates.push({
      label: "ssh-agent",
      config: { agent: process.env.SSH_AUTH_SOCK },
    });
  }

  if (!explicitKey) {
    const home = os.homedir();
    const defaultKeys = [
      path.join(home, ".ssh", "id_ed25519"),
      path.join(home, ".ssh", "id_rsa"),
      path.join(home, ".ssh", "id_ecdsa"),
      path.join(home, ".ssh", "id_dsa"),
    ];

    for (const keyPath of defaultKeys) {
      if (await fileExists(keyPath)) {
        candidates.push({
          label: `privateKeyPath:${keyPath}`,
          config: { privateKeyPath: keyPath },
        });
      }
    }
  }

  return candidates;
}

async function connectSSH(ssh, server) {
  const candidates = await buildAuthCandidates(server);
  if (candidates.length === 0) {
    throw new Error(
      `Nenhuma credencial SSH disponivel para ${server.user}@${server.ip}. Configure key no servidor ou habilite SSH agent.`,
    );
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      await ssh.connect({
        host: server.ip,
        username: server.user,
        ...candidate.config,
      });
      return;
    } catch (error) {
      errors.push(`${candidate.label} -> ${error.message}`);
    }
  }

  throw new Error(`Falha de autenticacao SSH para ${server.user}@${server.ip}. Tentativas: ${errors.join(" | ")}`);
}

async function runRemote(ssh, command, cwd) {
  const result = await ssh.execCommand(command, cwd ? { cwd } : undefined);
  if (result.code !== 0) {
    throw new Error(`Erro no comando [${command}]: ${result.stderr || result.stdout || "sem detalhes"}`);
  }
  return result.stdout;
}

async function transferArchiveWithChecks({ sourceSsh, targetSsh, sourceArchive, localArchive, targetArchive, targetPath }) {
  const sourceStat = await runRemote(
    sourceSsh,
    `test -f ${shellQuote(sourceArchive)} && stat -c %s ${shellQuote(sourceArchive)}`,
  );
  const sourceSize = Number(String(sourceStat).trim());
  if (!Number.isFinite(sourceSize) || sourceSize <= 0) {
    throw new Error(`Arquivo de dump invalido na origem: ${sourceArchive} (size=${sourceStat}).`);
  }

  try {
    await sourceSsh.getFile(localArchive, sourceArchive);
  } catch (error) {
    throw new Error(`Falha ao baixar dump da origem para host local: ${error.message || error}`);
  }

  await runRemote(targetSsh, `mkdir -p ${shellQuote(targetPath)} && test -w ${shellQuote(targetPath)}`);
  // Cleanup old migration artifacts to reclaim space before upload.
  await runRemote(
    targetSsh,
    `find ${shellQuote(targetPath)} -maxdepth 1 \\( -name '*_migration_dump.tar.gz' -o -name '*_temp_dump' \\) -mtime +1 -exec rm -rf {} + || true`,
  );

  const targetAvailRaw = await runRemote(
    targetSsh,
    `df -Pk ${shellQuote(targetPath)} | awk 'NR==2 {print $4}'`,
  );
  const targetAvailBytes = Number(String(targetAvailRaw).trim()) * 1024;
  const targetInodesRaw = await runRemote(
    targetSsh,
    `df -Pi ${shellQuote(targetPath)} | awk 'NR==2 {print $4}'`,
  );
  const targetFreeInodes = Number(String(targetInodesRaw).trim());
  const safetyMarginBytes = 200 * 1024 * 1024;
  if (!Number.isFinite(targetAvailBytes)) {
    throw new Error(`Nao foi possivel calcular espaco livre em ${targetPath}.`);
  }
  if (!Number.isFinite(targetFreeInodes)) {
    throw new Error(`Nao foi possivel calcular inodes livres em ${targetPath}.`);
  }
  if (targetFreeInodes < 5) {
    throw new Error(`Destino sem inodes livres suficientes em ${targetPath} (livres=${targetFreeInodes}).`);
  }
  if (targetAvailBytes < sourceSize + safetyMarginBytes) {
    throw new Error(
      `Espaco insuficiente no destino. Necessario ~${sourceSize} bytes (+margem), disponivel ${targetAvailBytes} bytes em ${targetPath}.`,
    );
  }
  await runRemote(
    targetSsh,
    `tmp_test_file=${shellQuote(`${targetPath}/.write_test_${Date.now()}`)} && touch "$tmp_test_file" && rm -f "$tmp_test_file"`,
  );

  try {
    await targetSsh.putFile(localArchive, targetArchive);
  } catch (error) {
    throw new Error(`Falha ao enviar dump do host para destino via SFTP: ${error.message || error}`);
  }
}

async function uploadViaScpFallback({ localArchive, targetArchive, target, targetSsh, sourceSize }) {
  const tempRemoteArchive = `/tmp/${path.basename(targetArchive)}`;
  const targetRef = `${target.user}@${target.ip}:${tempRemoteArchive}`;
  const args = ["-o", "StrictHostKeyChecking=no"];
  const keyPath = resolvePrivateKey(target);
  if (keyPath) {
    args.push("-i", keyPath);
  }
  args.push(localArchive, targetRef);

  try {
    await execFileAsync("scp", args);
  } catch (error) {
    let diagnostics = "";
    try {
      const tmpUsage = await runRemote(targetSsh, "df -h /tmp | tail -n 1");
      const tmpInodes = await runRemote(targetSsh, "df -i /tmp | tail -n 1");
      const tmpPerms = await runRemote(targetSsh, "ls -ld /tmp");
      diagnostics = ` | Diagnostico /tmp => uso: [${tmpUsage.trim()}], inodes: [${tmpInodes.trim()}], perms: [${tmpPerms.trim()}]`;
    } catch (diagError) {
      diagnostics = ` | Diagnostico /tmp indisponivel: ${diagError.message}`;
    }
    throw new Error(
      `Falha ao enviar dump do host para destino via SCP fallback: ${error.stderr || error.stdout || error.message || error}${diagnostics}`,
    );
  }

  await runRemote(
    targetSsh,
    `test -f ${shellQuote(tempRemoteArchive)} && cp ${shellQuote(tempRemoteArchive)} ${shellQuote(targetArchive)} && rm -f ${shellQuote(tempRemoteArchive)}`,
  );
  const uploadedStat = await runRemote(targetSsh, `stat -c %s ${shellQuote(targetArchive)}`);
  const uploadedSize = Number(String(uploadedStat).trim());
  if (!Number.isFinite(uploadedSize) || uploadedSize <= 0) {
    throw new Error(`SCP fallback concluiu, mas arquivo final no destino esta invalido: ${targetArchive} (size=${uploadedStat}).`);
  }
  if (Number.isFinite(sourceSize) && uploadedSize !== sourceSize) {
    throw new Error(
      `SCP fallback concluiu com tamanho divergente no destino (origem=${sourceSize}, destino=${uploadedSize}).`,
    );
  }
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function buildMongoConnectionArgCandidates(server, database) {
  const dbName = database || "myapp";
  if (server.mongoUri) {
    return [`--uri ${shellQuote(server.mongoUri)} --db ${shellQuote(dbName)}`];
  }
  const hosts = [...new Set(["127.0.0.1", server.ip].filter(Boolean))];
  return hosts.map((host) => `--host ${shellQuote(host)} --port 27017 --db ${shellQuote(dbName)}`);
}

async function runMongoToolWithFallback(ssh, connectionArgCandidates, buildCommand) {
  const errors = [];
  for (const args of connectionArgCandidates) {
    const command = buildCommand(args);
    try {
      await runRemote(ssh, command);
      return args;
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`Falha ao executar ferramenta Mongo com todas as conexoes testadas. Tentativas: ${errors.join(" | ")}`);
}

async function runDestinationMetadataUpdate(targetSsh, target, targetMongoArgCandidates) {
  const databaseName = target.database || "myapp";
  const collectionName = target.metadataCollection || "app_metadata";
  const updateScript = `
const dbRef = db.getSiblingDB(${JSON.stringify(databaseName)});
const result = dbRef.getCollection(${JSON.stringify(collectionName)}).updateOne(
  {},
  { $set: { name: ${JSON.stringify(target.name || "")}, login: ${JSON.stringify(target.login || "")}, nickname: ${JSON.stringify(target.nickname || "")} } },
  { upsert: true }
);
if (!result || result.acknowledged !== true) {
  printjson(result);
  quit(2);
}
if ((result.matchedCount || 0) === 0 && (result.upsertedCount || 0) === 0) {
  printjson(result);
  quit(3);
}
printjson(result);
`;
  const errors = [];
  for (const args of targetMongoArgCandidates) {
    const mongoTarget = args.includes("--uri")
      ? `${args.match(/--uri\s+('[^']*'|"[^"]*"|\S+)/)?.[1] || ""} `
      : `${args} `;
    const attempts = [
      `mongosh ${mongoTarget}--quiet --eval ${shellQuote(updateScript)}`,
      `mongo ${mongoTarget}--quiet --eval ${shellQuote(updateScript)}`,
    ];
    for (const command of attempts) {
      try {
        await runRemote(targetSsh, command);
        return;
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  throw new Error(`Falha ao atualizar metadados do destino. Tentativas: ${errors.join(" | ")}`);
}

async function runRestart(targetSsh, target, sudoPassword) {
  if (!sudoPassword) {
    throw new Error("Senha sudo nao informada para reiniciar servidor destino.");
  }
  const restartCommand = target.restartCommand || "systemctl reboot || reboot";
  const command = `echo ${shellQuote(sudoPassword)} | sudo -S -p '' sh -lc ${shellQuote(restartCommand)}`;
  const result = await targetSsh.execCommand(`sh -lc ${shellQuote(command)}`);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Falha ao reiniciar servidor destino.");
  }
}

async function validateSudoPassword(targetSsh, sudoPassword) {
  if (!sudoPassword) {
    throw new Error("Senha sudo nao informada.");
  }
  const command = `echo ${shellQuote(sudoPassword)} | sudo -S -k -p '' true`;
  const result = await targetSsh.execCommand(`sh -lc ${shellQuote(command)}`);
  if (result.code !== 0) {
    throw new Error("Senha sudo invalida para o servidor destino.");
  }
}

async function runDry(jobId) {
  for (const step of stepPlan) {
    updateJob(jobId, { status: "running", progress: step.progress, message: step.message });
    appendLog(jobId, { level: "info", message: step.message });
    await sleep(1200);
  }
}

export async function runMigrationJob({ jobId, origin, destination, flags = {}, sudoPassword }) {
  const source = getSourceServer(origin);
  const target = getTargetServer(destination);
  const sourceDatabase = source?.database || "myapp";
  const targetDatabase = target?.database || "myapp";
  const sourceMongoArgCandidates = buildMongoConnectionArgCandidates(source || {}, sourceDatabase);
  const targetMongoArgCandidates = buildMongoConnectionArgCandidates(target || {}, targetDatabase);

  if (!source || !target) {
    updateJob(jobId, {
      status: "error",
      progress: 100,
      message: "Falha: Servidor de origem ou destino invalido.",
    });
    return;
  }

  let sourceSsh;
  let targetSsh;
  let tempDir;
  let sourceArchive;
  let sourceDumpDir;
  let targetArchive;
  let targetDumpDir;

  try {
    if (DRY_RUN) {
      await runDry(jobId);
      updateJob(jobId, {
        status: "success",
        progress: 100,
        message: "Migracao concluida (modo simulacao).",
      });
      return;
    }

    sourceSsh = new NodeSSH();
    targetSsh = new NodeSSH();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mongo-migracao-"));
    const localArchive = path.join(tempDir, `${jobId}.tar.gz`);
    sourceArchive = `${source.path}/${jobId}_migration_dump.tar.gz`;
    sourceDumpDir = `${source.path}/${jobId}_temp_dump`;
    targetArchive = `${target.path}/${jobId}_migration_dump.tar.gz`;
    targetDumpDir = `${target.path}/${jobId}_temp_dump`;
    const targetPreDropBackupDir = `${target.path}/${jobId}_pre_drop_backup`;
    const targetPreDropBackupArchive = `${target.path}/${jobId}_pre_drop_backup.tar.gz`;

    updateJob(jobId, { status: "running", progress: 10, message: "Validacao inicial dos servidores..." });
    await connectSSH(targetSsh, target);
    updateJob(jobId, { status: "running", progress: 5, message: "Validando senha sudo no destino..." });
    await validateSudoPassword(targetSsh, sudoPassword);
    await connectSSH(sourceSsh, source);
    await runRemote(sourceSsh, "df -h");
    await runRemote(targetSsh, `mkdir -p ${target.path} && df -h`);

    updateJob(jobId, { status: "running", progress: 25, message: "Gerando mongodump na origem..." });
    await runRemote(sourceSsh, `mkdir -p ${source.path} && rm -rf ${sourceDumpDir} && mkdir -p ${sourceDumpDir}`);
    await runMongoToolWithFallback(sourceSsh, sourceMongoArgCandidates, (args) => `mongodump ${args} --out ${shellQuote(sourceDumpDir)}`);

    updateJob(jobId, { status: "running", progress: 40, message: "Comprimindo dump..." });
    await runRemote(sourceSsh, `tar -czf ${sourceArchive} -C ${sourceDumpDir} .`);

    updateJob(jobId, { status: "running", progress: 60, message: "Baixando dump da origem para host..." });
    try {
      await transferArchiveWithChecks({
        sourceSsh,
        targetSsh,
        sourceArchive,
        localArchive,
        targetArchive,
        targetPath: target.path,
      });
    } catch (sftpError) {
      updateJob(jobId, { status: "running", progress: 64, message: "SFTP falhou, tentando upload por SCP..." });
      await uploadViaScpFallback({
        localArchive,
        targetArchive,
        target,
        targetSsh,
        sourceSize: Number((await fs.stat(localArchive)).size),
      });
    }
    updateJob(jobId, { status: "running", progress: 68, message: "Upload do dump para destino concluido." });

    updateJob(jobId, { status: "running", progress: 75, message: "Extraindo dump no destino..." });
    await runRemote(targetSsh, `rm -rf ${targetDumpDir} && mkdir -p ${targetDumpDir}`);
    await runRemote(targetSsh, `tar -xzf ${targetArchive} -C ${targetDumpDir}`);

    if (flags.drop) {
      updateJob(jobId, { status: "running", progress: 84, message: "Gerando backup pre-drop no destino..." });
      await runRemote(
        targetSsh,
        `rm -rf ${targetPreDropBackupDir} ${targetPreDropBackupArchive} && mkdir -p ${targetPreDropBackupDir}`,
      );
      await runMongoToolWithFallback(
        targetSsh,
        targetMongoArgCandidates,
        (args) => `mongodump ${args} --out ${shellQuote(targetPreDropBackupDir)}`,
      );
      await runRemote(targetSsh, `tar -czf ${targetPreDropBackupArchive} -C ${targetPreDropBackupDir} .`);
    }

    updateJob(jobId, { status: "running", progress: 90, message: "Executando mongorestore..." });
    const dropFlag = flags.drop ? "--drop" : "";
    await runMongoToolWithFallback(
      targetSsh,
      targetMongoArgCandidates,
      (args) => `mongorestore ${dropFlag} ${args} ${shellQuote(targetDumpDir)}`.trim(),
    );

    updateJob(jobId, { status: "running", progress: 94, message: "Atualizando metadados do destino..." });
    await runDestinationMetadataUpdate(targetSsh, target, targetMongoArgCandidates);

    updateJob(jobId, { status: "running", progress: 98, message: "Limpando arquivos temporarios..." });

    if (flags.drop) {
      updateJob(jobId, { status: "running", progress: 99, message: "Reiniciando servidor destino..." });
      await runRestart(targetSsh, target, sudoPassword);
    }

    updateJob(jobId, { status: "success", progress: 100, message: "Migracao concluida com sucesso." });
  } catch (error) {
    const rawMessage = error?.message || String(error);
    const currentStep = getJob(jobId)?.message || "etapa desconhecida";
    const detailedMessage =
      rawMessage.trim().toLowerCase() === "failure"
        ? `Failure during step "${currentStep}". Verifique permissao/espaco/comando remoto no servidor de origem/destino.`
        : rawMessage;

    appendLog(jobId, { level: "error", message: detailedMessage });
    updateJob(jobId, {
      status: "error",
      progress: 100,
      message: mapErrorMessage(detailedMessage),
    });
  } finally {
    // Always cleanup migration temporary artifacts, even on failure.
    // Intentionally preserve *_pre_drop_backup* for rollback safety.
    try {
      if (sourceSsh && sourceDumpDir && sourceArchive) {
        await sourceSsh.execCommand(`rm -rf ${shellQuote(sourceDumpDir)} ${shellQuote(sourceArchive)} || true`);
      }
    } catch {}

    try {
      if (targetSsh && targetDumpDir && targetArchive) {
        await targetSsh.execCommand(`rm -rf ${shellQuote(targetDumpDir)} ${shellQuote(targetArchive)} || true`);
      }
    } catch {}

    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch {}

    try {
      sourceSsh?.dispose();
    } catch {}
    try {
      targetSsh?.dispose();
    } catch {}
  }
}
