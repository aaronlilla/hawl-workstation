export function getOrcaCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'orca-ide'
  }
  if (platform === 'win32') {
    return 'hws.cmd'
  }
  return 'orca'
}
