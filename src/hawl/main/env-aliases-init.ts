import { applyHawlEnvAliases } from './env-aliases'

// Runs when imported; keep this import first in each entry point so later modules see the ORCA_* twins.
applyHawlEnvAliases()
