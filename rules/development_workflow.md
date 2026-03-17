# Development Workflow Rules

## 📦 Version Management
- **ABSOLUTE PRIORITY**: Every code change MUST be accompanied by a version bump in `package.json` and `README.md`.
- **Versioning Strategy**: Use semantic versioning. For small fixes or UI tweaks, bump the patch version (e.g., 2.4.1 -> 2.4.2).
- **Deployment**: After bumping the version, always deploy the new version to the Antigravity extensions directory (`C:\Users\lau\.antigravity\extensions\venomchampion.antigravity-account-switcher-X.X.X`).

## 🚀 Deployment Process
1. Update version in `package.json`.
2. Update version and changelog summary in `README.md`.
3. Create the new versioned folder in the extensions directory.
4. Copy `extension.js`, `package.json`, and the `scripts/` folder to the new location.
5. **Packaging**: To create a `.vsix`, run: `npx @vscode/vsce package --allow-star-activation --no-git-tag-version`.
