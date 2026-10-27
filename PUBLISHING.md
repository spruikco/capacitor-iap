# Publishing to npm

Today the plugin installs from GitHub (`npm install github:spruikco/capacitor-iap`), which needs nothing from npm. Publishing makes it `npm install @spruik/capacitor-iap`.

The package name must stay `@spruik/capacitor-iap`: it decides the Swift package name (`SpruikCapacitorIap`). So the npm account that publishes has to be able to publish under the `@spruik` scope.

## One time (Rye)

1. Sign in at https://www.npmjs.com as the account that owns the `@spruik` organisation.
2. Organisation `spruik`, Members, Invite: add the `spruikco` npm user with the Developer role (or Owner). Accept the invite as `spruikco`.
3. In a terminal on this PC: `npm login` (browser sign-in as `spruikco`, security key for 2FA). Check with `npm whoami`.

## Each release

```bash
npm test              # money rules in the Vend16 helper
npm run pack:check    # the 15 files that ship, about 24 kB
npm version patch     # or minor; commits and tags
npm publish           # publishConfig makes it public; npm asks for the 2FA key
git push --follow-tags
```

After the first publish, update the install line in README.md, AGENTS.md, and the Vend16 docs (vend16.com/docs, llms-full.txt, the vend16-skill plugin) from `github:spruikco/capacitor-iap` to `@spruik/capacitor-iap`.
