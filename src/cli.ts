import { spawn, type ChildProcess } from 'node:child_process';
import { createPopmelt } from './server/bridge-server';

const TAG = '\x1b[35m[popmelt]\x1b[0m';

async function main() {
  const args = process.argv.slice(2);

  // popmelt wrap -- <command...>
  if (args[0] === 'wrap') {
    const dashDash = args.indexOf('--');
    if (dashDash === -1 || dashDash === args.length - 1) {
      console.error(`${TAG} Usage: popmelt wrap -- <dev command>`);
      console.error(`${TAG} Example: popmelt wrap -- next dev`);
      console.error(`${TAG} Example: popmelt wrap -- astro dev`);
      process.exit(1);
    }
    const cmd = args.slice(dashDash + 1);
    await wrapCommand(cmd);
    return;
  }

  // popmelt bridge (standalone bridge)
  if (args[0] === 'bridge') {
    await runBridge();
    return;
  }

  // Default: show help
  console.log(`${TAG} Popmelt — design collaboration for AI coding agents`);
  console.log('');
  console.log('  popmelt wrap -- <command>   Start bridge + dev server together');
  console.log('  popmelt bridge              Start the bridge server standalone');
  console.log('');
  console.log('Examples:');
  console.log('  popmelt wrap -- next dev');
  console.log('  popmelt wrap -- astro dev');
  console.log('  popmelt wrap -- vite');
  console.log('');
  console.log('In package.json:');
  console.log('  "scripts": { "dev": "popmelt wrap -- next dev" }');
}

async function runBridge(): Promise<void> {
  const handle = await createPopmelt({
    projectRoot: process.cwd(),
  });
  console.log(`${TAG} Bridge running on http://localhost:${handle.port}`);

  // Keep alive until signal
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log(`\n${TAG} Shutting down bridge...`);
      await handle.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

async function wrapCommand(cmd: string[]): Promise<void> {
  // Start bridge first
  const handle = await createPopmelt({
    projectRoot: process.cwd(),
  });
  console.log(`${TAG} Bridge running on http://localhost:${handle.port}`);

  // Spawn user's dev command
  const [bin, ...rest] = cmd;
  console.log(`${TAG} Starting: ${cmd.join(' ')}`);

  const child: ChildProcess = spawn(bin!, rest, {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      POPMELT_BRIDGE_URL: `http://localhost:${handle.port}`,
    },
  });

  // Forward signals to child
  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  // When child exits, tear down bridge and exit with same code
  child.on('exit', async (code, signal) => {
    await handle.close();
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

main().catch((err) => {
  console.error(`${TAG} Fatal:`, err);
  process.exit(1);
});
