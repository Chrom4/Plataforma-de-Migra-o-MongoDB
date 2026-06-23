import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

const STATUS_LABELS = {
  started: "Iniciado",
  running: "Em execucao",
  success: "Concluido",
  error: "Erro",
};

function App() {
  const [sourceServers, setSourceServers] = useState([]);
  const [targetServers, setTargetServers] = useState([]);
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [drop, setDrop] = useState(true);
  const [sudoPassword, setSudoPassword] = useState("");
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingServers, setLoadingServers] = useState(true);
  const [apiMode, setApiMode] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((response) => response.json())
      .then((data) => setApiMode(data.mode === "live" ? "live" : "dry-run"))
      .catch(() => setApiMode(null));
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/servers`)
      .then((response) => response.json())
      .then((data) => {
        if (Array.isArray(data.servers)) {
          setSourceServers(data.servers);
          setTargetServers(data.servers);
          return;
        }
        setSourceServers(data.sources || []);
        setTargetServers(data.targets || []);
      })
      .catch(() => setError("Nao foi possivel carregar servidores. Verifique se o backend esta rodando."))
      .finally(() => setLoadingServers(false));
  }, []);

  useEffect(() => {
    if (!jobId) return undefined;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/status/${jobId}`);
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Erro ao consultar job.");
        setJob(data);
      } catch (pollError) {
        setError(pollError.message);
      }
    }, 3000);

    return () => window.clearInterval(interval);
  }, [jobId]);

  const canSubmit = useMemo(
    () => origin && destination && origin !== destination && !loading && !loadingServers,
    [origin, destination, loading, loadingServers],
  );
  const canConfirmPassword = useMemo(
    () => sudoPassword.trim().length > 0 && !loading,
    [sudoPassword, loading],
  );

  function handleSubmit(event) {
    event.preventDefault();
    setSudoPassword("");
    setShowPasswordModal(true);
  }

  async function confirmAndStartMigration() {
    setError("");
    setLoading(true);
    setJob(null);

    try {
      const response = await fetch(`${API_BASE}/api/migrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin,
          destination,
          flags: { drop },
          sudoPassword,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Falha ao iniciar migracao.");
      setJobId(data.jobId);
      setJob({
        jobId: data.jobId,
        status: data.status,
        progress: 1,
        message: "Job criado.",
      });
      setShowPasswordModal(false);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app">
      <header className="appHeader">
        <div>
          <h1>Migracao de Bases MongoDB</h1>
          <p className="subtitle">
            Selecione origem e destino, dispare o job e acompanhe em tempo real.
          </p>
        </div>
        {apiMode && (
          <span className={`modeBadge ${apiMode === "live" ? "live" : "dryRun"}`}>
            {apiMode === "live" ? "Modo live" : "Modo simulacao"}
          </span>
        )}
      </header>

      <form onSubmit={handleSubmit} className="card">
        <label>
          Origem
          <select
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            disabled={loadingServers}
          >
            <option value="">
              {loadingServers ? "Carregando servidores..." : "Selecione"}
            </option>
            {sourceServers.map((server) => (
              <option key={`origin-${server.name}`} value={server.name}>
                {server.name} ({server.ip})
              </option>
            ))}
          </select>
        </label>

        <label>
          Destino
          <select
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            disabled={loadingServers}
          >
            <option value="">
              {loadingServers ? "Carregando servidores..." : "Selecione"}
            </option>
            {targetServers.map((server) => (
              <option key={`destination-${server.name}`} value={server.name}>
                {server.name} ({server.ip})
              </option>
            ))}
          </select>
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={drop}
            onChange={(e) => setDrop(e.target.checked)}
          />
          Executar restore com --drop
        </label>

        <button type="submit" disabled={!canSubmit}>
          {loading ? "Iniciando..." : "Iniciar Migracao"}
        </button>
      </form>

      {showPasswordModal && (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modalContent">
            <h3>Confirmar senha sudo</h3>
            <p>
              Digite a senha sudo do servidor destino para iniciar a migracao.
            </p>
            <input
              type={showPassword ? "text" : "password"}
              value={sudoPassword}
              onChange={(e) => setSudoPassword(e.target.value)}
              placeholder="Senha sudo"
              autoFocus
              autoComplete="off"
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showPassword}
                onChange={(e) => setShowPassword(e.target.checked)}
              />
              Mostrar senha
            </label>
            <div className="modalActions">
              <button
                type="button"
                onClick={() => setShowPasswordModal(false)}
                disabled={loading}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmAndStartMigration}
                disabled={!canConfirmPassword}
              >
                {loading ? "Validando..." : "Confirmar e migrar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {job && (
        <section className={`card jobCard status-${job.status || "running"}`}>
          <h2>Status do Job</h2>
          <p>
            <strong>ID:</strong> {job.jobId}
          </p>
          <p>
            <strong>Status:</strong>{" "}
            <span className="statusLabel">
              {STATUS_LABELS[job.status] || job.status}
            </span>
          </p>
          <p>{job.message}</p>
          <div className="progressBar">
            <div
              style={{
                width: `${Math.min(100, Math.max(0, job.progress || 0))}%`,
              }}
            />
          </div>
          <p className="progressText">{job.progress || 0}%</p>
        </section>
      )}
    </main>
  );
}

export default App;
