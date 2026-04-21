import { $ } from "bun";

await $`bun build ./index.html --outdir=./dist`.quiet();