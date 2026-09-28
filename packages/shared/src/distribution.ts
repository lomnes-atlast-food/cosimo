/**
 * Distribution constants. install.sh / install.ps1 mirror these as variables at the top.
 */
export const GITHUB_REPO = "steve-lomnes/cosimo";
export const RELEASES_BASE_URL = `https://github.com/${GITHUB_REPO}/releases`;
export const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
export const INSTALL_URL = `${RELEASES_BASE_URL}/latest/download/install.sh`;
export const INSTALL_PS1_URL = `${RELEASES_BASE_URL}/latest/download/install.ps1`;
export const AGENTS_MD_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/AGENTS.md`;
export const DOCKER_IMAGE = "ghcr.io/steve-lomnes/cosimo";

// The version and commit are injected at build time (build-binary.ts, Dockerfile); a source run
// (`bun run`, `bun test`) never sees them, so it reports DEV_VERSION and never calls out for an
// update (see services/updates.ts).
declare const __COSIMO_VERSION__: string | undefined;
declare const __COSIMO_COMMIT__: string | undefined;
export const DEV_VERSION = "0.0.0-dev";
export const VERSION = typeof __COSIMO_VERSION__ === "string" ? __COSIMO_VERSION__ : DEV_VERSION;
export const COMMIT = typeof __COSIMO_COMMIT__ === "string" ? __COSIMO_COMMIT__ : "";
export const isDevBuild = () => VERSION === DEV_VERSION;
