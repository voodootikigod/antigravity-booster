# Linux Sandbox Research

## Context
Antigravity's current gate sandboxing relies on macOS `sandbox-exec` (Seatbelt) to prevent malicious or broken builder agents from escaping the worktree during test execution. 
Specifically, the sandbox provides:
1. **Network Denial**: `(deny network*)`
2. **Global Write Denial**: `(deny file-write*)`
3. **Targeted Write Allowance**: Allows writes only to the worktree (`cwd`) and temporary directories.
4. **Targeted Write Denial**: Explicitly denies writes to `.git` and `node_modules` inside the worktree to prevent persistence after a rollback.

Currently, on Linux, sandboxing fails closed unless running inside a disposable container with `AGB_SANDBOX_GATES=0`. This research evaluates mechanisms to bring equivalent sandbox functionality to Ubuntu Linux, improving operational ease and security parity.

## Evaluated Alternatives

### 1. Bubblewrap (`bwrap`)
Bubblewrap is a core, unprivileged sandboxing tool based on Linux namespaces (user, mount, network, pid). It is used extensively by Flatpak and is available in Ubuntu's standard repositories.

**Pros:**
- **Unprivileged**: Can be run by regular users without root access (uses unprivileged user namespaces).
- **Exact mapping to Seatbelt rules**:
  - Network denial: `--unshare-net`
  - Global read-only: `--ro-bind / /`
  - Targeted write allowance: `--bind <cwd> <cwd>` and `--bind /tmp /tmp`
  - Targeted write denial: `--ro-bind <cwd>/.git <cwd>/.git` and `--ro-bind <cwd>/node_modules <cwd>/node_modules`
- **Lightweight**: Minimal overhead, fast startup.

**Cons:**
- Requires `bubblewrap` to be installed on the host (`apt-get install bubblewrap`).
- Does not have a default profile like `sandbox-exec`; every bind mount must be explicitly declared on the command line.

### 2. Firejail
Firejail is an SUID program that reduces the risk of security breaches by restricting the running environment of untrusted applications using Linux namespaces and seccomp-bpf.

**Pros:**
- Rich profile system (similar to Seatbelt).
- Built-in network restrictions (`--net=none`).
- Easy syntax for blacklisting/read-only directories (`--read-only=<cwd>/.git`).

**Cons:**
- Relies on SUID binary (historically has had some CVEs due to its SUID nature).
- Overkill for simple gate sandboxing.
- Heavier to configure programmatically compared to `bwrap`.

### 3. AppArmor
AppArmor is a Linux kernel security module that allows the system administrator to restrict programs' capabilities with per-program profiles.

**Pros:**
- Deep kernel integration, very secure.
- Supported out-of-the-box on Ubuntu.

**Cons:**
- Requires root privileges to load profiles into the kernel.
- We would need to dynamically generate and load profiles per worktree, which is not feasible for an unprivileged Node.js CLI tool.

### 4. systemd-nspawn
A container tool provided by systemd.

**Pros:**
- Powerful and well-integrated into Linux.
**Cons:**
- Requires root to run.
- Slower startup time, heavier isolation (full container rather than just a restricted shell).

## Proposed Implementation Strategy

**Recommendation: Bubblewrap (`bwrap`)**

Bubblewrap offers the most direct equivalent to macOS `sandbox-exec` for our use case: it does not require root, perfectly aligns with our requirement for targeted bind-mounting and network isolation, and is lightweight enough to not block the event loop or slow down concurrent gates.

### Implementation Steps

1. **Detection**: Update `lib/gates.mjs` and `lib/doctor.mjs` to detect `bwrap` via `which bwrap` on Linux platforms.
2. **Command Translation**: Create a `linuxBwrapProfile` function in `lib/gates.mjs` that translates the `cwd` into a `bwrap` command array.
   - Example equivalent command:
     ```bash
     bwrap \
       --unshare-net \
       --ro-bind / / \
       --bind /tmp /tmp \
       --bind /var/tmp /var/tmp \
       --bind /dev /dev \
       --bind <cwd> <cwd> \
       --ro-bind <cwd>/.git <cwd>/.git \
       --ro-bind <cwd>/node_modules <cwd>/node_modules \
       -- /bin/sh -c "<cmd>"
     ```
3. **Fallback Logic**: If `bwrap` is missing on Linux, continue to fail closed and prompt the user to either install `bubblewrap` or set `AGB_SANDBOX_GATES=0`.
4. **Testing**: Update `test/security.test.mjs` to run the sandbox tests on Linux if `bwrap` is available.
