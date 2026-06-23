const jobs = new Map();

export function createJob(jobId, payload) {
  const now = new Date().toISOString();
  jobs.set(jobId, {
    jobId,
    status: "started",
    progress: 0,
    message: "Job criado",
    payload,
    createdAt: now,
    updatedAt: now,
    logs: [],
  });
}

export function updateJob(jobId, patch) {
  const current = jobs.get(jobId);
  if (!current) return null;

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  jobs.set(jobId, next);
  return next;
}

export function appendLog(jobId, log) {
  const current = jobs.get(jobId);
  if (!current) return;
  current.logs.push({
    at: new Date().toISOString(),
    ...log,
  });
  current.updatedAt = new Date().toISOString();
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}
