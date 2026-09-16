/** Mount root of the Computer workspace; `computerd` mounts the VFS here inside the container. */
export const COMPUTER_WORKSPACE_ROOT = '/workspace';

export const COMPUTER_UPLOADS_DIR = `${COMPUTER_WORKSPACE_ROOT}/uploads`;
export const COMPUTER_TOOL_RESULT_DIR = `${COMPUTER_WORKSPACE_ROOT}/.trueforge/tool-results`;
export const COMPUTER_SKILLS_DIR = `${COMPUTER_WORKSPACE_ROOT}/.trueforge/skills`;
export const COMPUTER_SKILL_DOWNLOADER_PATH = `${COMPUTER_WORKSPACE_ROOT}/.trueforge/bin/skill_downloader.py`;
export const COMPUTER_GIT_CREDENTIALS_PATH = `${COMPUTER_WORKSPACE_ROOT}/.trueforge/git-credentials`;
