import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { DockerBackend, type DockerBackendOptions } from "./docker_backend";

import {
  FirecrackerBackend,
  type FirecrackerBackendOptions,
} from "./firecracker_backend";
import type { SandboxBackend } from "./types";

export interface CreateSandboxBackendOptions {
  backend?: "docker" | "firecracker" | "auto";
  docker?: DockerBackendOptions;
  firecracker?: FirecrackerBackendOptions;
}

async function hasKvm(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    await access("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function createSandboxBackend(
  options: CreateSandboxBackendOptions = {},
): Promise<SandboxBackend> {
  const backend = options.backend ?? "auto";
  if (backend === "docker") return new DockerBackend(options.docker);
  if (backend === "firecracker")
    return new FirecrackerBackend(options.firecracker);
  if (await hasKvm()) return new FirecrackerBackend(options.firecracker);
  return new DockerBackend(options.docker);
}
