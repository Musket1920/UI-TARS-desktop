const DEFAULT_AGENT_S_PORT = 10800;
export const DEFAULT_AGENT_S_ENDPOINT = `http://127.0.0.1:${DEFAULT_AGENT_S_PORT}`;

const hasValidPort = (port: number | undefined): port is number =>
  typeof port === 'number' && Number.isFinite(port) && port > 0;

const isLocalHttpHost = (hostname: string) =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '::1' ||
  hostname === '[::1]';

export const resolveSidecarEndpoint = (
  rawUrl: string | undefined,
  rawPort: number | undefined,
) => {
  const fallbackPort = hasValidPort(rawPort) ? rawPort : DEFAULT_AGENT_S_PORT;

  if (!rawUrl) {
    return `http://127.0.0.1:${fallbackPort}`;
  }

  try {
    const target = new URL(rawUrl);
    const isHttpOrHttps =
      target.protocol === 'http:' || target.protocol === 'https:';
    const shouldApplyFallbackPort =
      !target.port &&
      fallbackPort > 0 &&
      (!isHttpOrHttps || isLocalHttpHost(target.hostname));

    if (shouldApplyFallbackPort) {
      target.port = String(fallbackPort);
    }

    return target.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_AGENT_S_ENDPOINT;
  }
};
