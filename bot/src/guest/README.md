# guest

Code that runs *inside* the sandbox container, not in the harness process.

- `script_runner.ts` — entrypoint executed by the sandbox; reads the manifest, runs the user's script, captures outputs
