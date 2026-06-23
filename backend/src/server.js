import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { listServerOptions } from "./config/servers.js";
import { createJob, getJob, updateJob } from "./services/jobsStore.js";
import { runMigrationJob } from "./services/migrationRunner.js";

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(cors());
app.use(express.json());

app.get("/api/health", (_, res) => {
  res.json({ status: "ok", mode: process.env.DRY_RUN === "false" ? "live" : "dry-run" });
});

app.get("/api/servers", (_, res) => {
  res.json(listServerOptions());
});

app.post("/api/migrate", (req, res) => {
  const { origin, destination, flags = {}, sudoPassword } = req.body || {};
  if (!origin || !destination) {
    return res.status(400).json({ error: "Campos obrigatorios: origin e destination." });
  }
  if (origin === destination) {
    return res.status(400).json({ error: "Origem e destino nao podem ser iguais." });
  }
  if (!sudoPassword) {
    return res.status(400).json({ error: "Senha sudo obrigatoria para iniciar migracao." });
  }

  const jobId = uuidv4();
  createJob(jobId, { origin, destination, flags });
  updateJob(jobId, {
    status: "running",
    progress: 1,
    message: "Job iniciado e aguardando execucao...",
  });

  runMigrationJob({ jobId, origin, destination, flags, sudoPassword });
  return res.status(202).json({ jobId, status: "started" });
});

app.get("/api/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job nao encontrado." });
  }
  return res.json(job);
});

app.listen(port, () => {
  console.log(`Backend iniciado em http://localhost:${port}`);
});
