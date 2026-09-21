/**
 * Local persistence for EVM ABI Call projects (ABI JSON + contract address).
 */

export const EVM_ABI_PROJECTS_STORAGE_KEY = "fnzsafe.evm-abi-projects.v1";

export interface EvmAbiProject {
  id: string;
  name: string;
  chainId: number;
  chainName: string;
  contractAddress: string;
  abiJsonText: string;
  abiFileName: string;
  functionCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface EvmAbiProjectInput {
  name: string;
  chainId: number;
  chainName: string;
  contractAddress: string;
  abiJsonText: string;
  abiFileName: string;
  functionCount: number;
}

function newProjectId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `evm-abi:${crypto.randomUUID()}`;
  }
  return `evm-abi:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeEvmAbiProject(value: unknown): EvmAbiProject | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const chainId = Number(record.chainId);
  const chainName = typeof record.chainName === "string" ? record.chainName.trim() : "";
  const contractAddress = typeof record.contractAddress === "string"
    ? record.contractAddress.trim()
    : "";
  const abiJsonText = typeof record.abiJsonText === "string" ? record.abiJsonText : "";
  const abiFileName = typeof record.abiFileName === "string" ? record.abiFileName.trim() : "";
  const functionCount = Number(record.functionCount);
  const createdAt = Number(record.createdAt);
  const updatedAt = Number(record.updatedAt);
  if (!id || !name || !Number.isFinite(chainId) || chainId <= 0) return null;
  if (!contractAddress || !abiJsonText) return null;
  return {
    id,
    name,
    chainId,
    chainName: chainName || `chain ${chainId}`,
    contractAddress,
    abiJsonText,
    abiFileName: abiFileName || "abi.json",
    functionCount: Number.isFinite(functionCount) && functionCount > 0 ? functionCount : 0,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
  };
}

export function parseEvmAbiProjectsJson(raw: string | null | undefined): EvmAbiProject[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { projects?: unknown }).projects)
        ? (parsed as { projects: unknown[] }).projects
        : [];
    return list
      .map((item) => normalizeEvmAbiProject(item))
      .filter((item): item is EvmAbiProject => Boolean(item))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function loadEvmAbiProjects(): EvmAbiProject[] {
  if (typeof window === "undefined") return [];
  try {
    return parseEvmAbiProjectsJson(window.localStorage.getItem(EVM_ABI_PROJECTS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveEvmAbiProjects(projects: EvmAbiProject[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    EVM_ABI_PROJECTS_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      projects,
    }),
  );
}

export function upsertEvmAbiProject(
  projects: EvmAbiProject[],
  input: EvmAbiProjectInput,
  existingId?: string,
): { projects: EvmAbiProject[]; project: EvmAbiProject } {
  const now = Date.now();
  const existing = existingId
    ? projects.find((item) => item.id === existingId)
    : undefined;
  const project: EvmAbiProject = {
    id: existing?.id || newProjectId(),
    name: input.name.trim(),
    chainId: input.chainId,
    chainName: input.chainName.trim() || `chain ${input.chainId}`,
    contractAddress: input.contractAddress.trim(),
    abiJsonText: input.abiJsonText,
    abiFileName: input.abiFileName.trim() || "abi.json",
    functionCount: input.functionCount,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const next = existing
    ? projects.map((item) => (item.id === existing.id ? project : item))
    : [project, ...projects];
  return {
    projects: next.sort((a, b) => b.updatedAt - a.updatedAt),
    project,
  };
}

export function deleteEvmAbiProject(
  projects: EvmAbiProject[],
  projectId: string,
): EvmAbiProject[] {
  return projects.filter((item) => item.id !== projectId);
}

export function shortContractAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length < 12) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}
