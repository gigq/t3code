import { type SshProjectLocation } from "@t3tools/contracts";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellEnvAssignments(env: NodeJS.ProcessEnv | undefined): string {
  if (!env) {
    return "";
  }

  const assignments: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    assignments.push(`${key}=${shellQuote(value)}`);
  }
  return assignments.join(" ");
}

export function buildRemoteShellCommand(input: {
  readonly cwd: string;
  readonly script: string;
}): string {
  return `cd ${shellQuote(input.cwd)} && ${input.script}`;
}

export function buildRemoteExecScript(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): string {
  const envAssignments = shellEnvAssignments(input.env);
  const command = [input.command, ...input.args].map(shellQuote).join(" ");
  return `${envAssignments ? `${envAssignments} ` : ""}exec ${command}`;
}

export function buildSshArgs(
  location: SshProjectLocation,
  remoteShellCommand: string,
  options?: { readonly allocateTty?: boolean },
): ReadonlyArray<string> {
  return [
    options?.allocateTty === true ? "-tt" : "-T",
    ...(location.port !== undefined ? ["-p", String(location.port)] : []),
    location.host,
    `exec /bin/sh -lc ${shellQuote(remoteShellCommand)}`,
  ];
}
