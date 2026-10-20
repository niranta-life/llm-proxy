import { execFileSync } from 'node:child_process';

export function useActiveDockerContext(): void {
  if (!process.env.DOCKER_HOST) {
    try {
      const host = execFileSync(
        'docker',
        ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        { encoding: 'utf8' },
      ).trim();
      if (host.startsWith('unix://') || host.startsWith('tcp://')) {
        process.env.DOCKER_HOST = host;
      }
    } catch {
      // Testcontainers reports a missing runtime if this probe fails.
    }
  }
  if (!process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE) {
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = '/var/run/docker.sock';
  }
}

useActiveDockerContext();
