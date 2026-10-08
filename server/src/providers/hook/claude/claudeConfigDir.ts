import * as os from 'os';
import * as path from 'path';

/** Claude Code's config root: $CLAUDE_CONFIG_DIR when set (Claude Code honors it
 *  for settings.json, projects/ and teams/), otherwise ~/.claude. */
export function getClaudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (override) {
    const expanded = override.startsWith('~')
      ? path.join(os.homedir(), override.slice(1))
      : override;
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), '.claude');
}
