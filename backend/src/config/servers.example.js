/**
 * Exemplo de configuracao de servidores para migracao MongoDB.
 * Copie para servers.local.js e ajuste com seus dados reais:
 *
 *   cp backend/src/config/servers.example.js backend/src/config/servers.local.js
 */
export const SOURCE_SERVERS = {
  STAGING_A: {
    name: "staging-a",
    login: "staging-a",
    nickname: "Staging A",
    ip: "10.0.0.10",
    user: "deploy",
    key: "example-key.pem",
    path: "/home/deploy/db/myapp",
    database: "myapp",
  },
  STAGING_B: {
    name: "staging-b",
    login: "staging-b",
    nickname: "Staging B",
    ip: "10.0.0.11",
    user: "deploy",
    key: "example-key.pem",
    path: "/home/deploy/db/myapp",
    database: "myapp",
  },
  PROD_BACKUP: {
    name: "prod-backup",
    login: "prod-backup",
    nickname: "Prod Backup",
    ip: "10.0.0.20",
    user: "admin",
    key: "example-key.pem",
    path: "/var/lib/mongodb/backups",
    database: "myapp",
  },
};

export const TARGET_SERVERS = {
  DEMO_A: {
    name: "demo-a",
    login: "demo-a",
    nickname: "Demo A",
    ip: "10.0.0.30",
    user: "deploy",
    key: "example-key.pem",
    path: "/home/deploy/db/myapp",
    database: "myapp",
    metadataCollection: "app_metadata",
    restartCommand: "systemctl restart myapp || true",
  },
  DEMO_B: {
    name: "demo-b",
    login: "demo-b",
    nickname: "Demo B",
    ip: "10.0.0.31",
    user: "deploy",
    path: "/home/deploy/db/myapp",
    database: "myapp",
    metadataCollection: "app_metadata",
  },
};
