const fs = require('fs');
const path = require('path');

// BYOK user skills (Phase 7.6): the desktop users' own skill files, read
// from `<userData>/byok-skills/*.md` and returned as text for the renderer.
// The renderer parses and validates them (ByokSkills.js) — this module only
// reads files, so a broken file can never take the main process down.

const BYOK_USER_SKILLS_FOLDER = 'byok-skills';

/**
 * Read the user skill files of the given user-data folder.
 * @param {string} userDataPath the Electron `app.getPath('userData')`
 * @returns {{ ok: true, data: Array<{ fileName: string, content: string }> } | { ok: false, error: string }}
 * Errors travel as values, never as exceptions (the ByokSafeStorage pattern).
 */
const readByokUserSkills = userDataPath => {
  try {
    const skillsFolder = path.join(userDataPath, BYOK_USER_SKILLS_FOLDER);
    if (!fs.existsSync(skillsFolder)) {
      return { ok: true, data: [] };
    }
    const fileNames = fs
      .readdirSync(skillsFolder, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort();
    const files = [];
    for (const fileName of fileNames) {
      try {
        const content = fs.readFileSync(
          path.join(skillsFolder, fileName),
          'utf8'
        );
        files.push({ fileName, content });
      } catch (error) {
        // One unreadable file must not hide the others.
      }
    }
    return { ok: true, data: files };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

module.exports = {
  BYOK_USER_SKILLS_FOLDER,
  readByokUserSkills,
};
