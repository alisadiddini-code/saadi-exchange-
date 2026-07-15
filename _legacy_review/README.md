# Legacy review archive

These files were moved here during a Stage 0 cleanup pass. They are
**not deleted** — this folder exists so they can be reviewed and removed (or
restored) deliberately, on purpose, rather than by accident.

Evidence each file is unused by the running app (checked before moving):

- `mai.tsx` — typo duplicate of `src/main.tsx`. `index.html` loads
  `./src/main.tsx` explicitly; `mai.tsx` is not referenced by any import,
  script, or config in the repo.
- `App_fixed_stable.tsx` — an older fork of `src/App.tsx`. Not imported
  anywhere. Note: it currently fails `tsc --noEmit` with 5 pre-existing type
  errors (unrelated to this move) — re-run `npx tsc --noEmit` to see them.
- `supabaseClient.ts` — an earlier, unused Supabase client setup. The app
  actually imports its client from `src/lib/supabase.ts`. Confirmed zero
  references anywhere in the repo via a repo-wide grep for the filename.

Verification method: `git log --all -- <file>` (last touched weeks/months
before the current `main` history moved on), plus a full-repo grep for each
filename with no hits outside the file itself, plus manual check of
`index.html`, `vite.config.ts`, `tsconfig.json`, and `package.json` for any
reference. Moving these files does not change Vite's bundle (Vite only
follows the import graph from `index.html`) and does not change
`tsc --noEmit`'s file discovery (no `include`/`exclude` is set in
`tsconfig.json`, so it scans the whole project regardless of this folder's
name).

No code in `src/` was changed to make this move — nothing imported these
files before, so nothing needed updating.
