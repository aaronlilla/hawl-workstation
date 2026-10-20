// Hawl: the Bitbucket, Azure DevOps and Gitea settings screens show HAWL_* variable names. Orca's code reads
// ORCA_*, so each HAWL_* variable is copied to its ORCA_* twin at startup (an explicit ORCA_* value wins).
const ALIAS_FAMILIES = ['BITBUCKET_', 'AZURE_DEVOPS_', 'GITEA_']

export function applyHawlEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('HAWL_')) {
      continue
    }
    const rest = key.slice('HAWL_'.length)
    if (!ALIAS_FAMILIES.some((family) => rest.startsWith(family))) {
      continue
    }
    const target = `ORCA_${rest}`
    if (env[target] === undefined) {
      env[target] = env[key]
    }
  }
}
