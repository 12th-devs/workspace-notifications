// Native desktop alerts use the connected site's existing session and container.
export const NATIVE_APPS = {
  calendar: {label: 'Calendar', url: 'https://calendar.google.com'},
  slack: {label: 'Slack', url: 'https://app.slack.com'},
  teams: {label: 'Microsoft Teams', url: 'https://teams.microsoft.com'},
  discord: {label: 'Discord', url: 'https://discord.com/app'},
  outlook: {label: 'Outlook', url: 'https://outlook.office.com/mail'},
};

export function nativeServiceForURL(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return null;
    const h = u.hostname;
    if (h === 'calendar.google.com') return 'calendar';
    if (h === 'app.slack.com' || /^[a-z0-9-]+\.slack\.com$/.test(h)) return 'slack';
    if (['teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com'].includes(h)) return 'teams';
    if (h === 'discord.com') return 'discord';
    if (['outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'outlook.cloud.microsoft'].includes(h)) return 'outlook';
  } catch (_e) {}
  return null;
}

export function matchesNativeSource(source, origin, containerId) {
  if (source.paused || source.ical || (source.containerId || 0) !== containerId) return false;
  if (nativeServiceForURL(origin) !== source.service) return false;
  // Calendar connections predate origin binding and always use one origin.
  if (source.service === 'calendar') return true;
  try { return new URL(source.url).origin === origin; } catch (_e) { return false; }
}
