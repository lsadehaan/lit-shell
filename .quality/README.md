# Quality ratchets

`crap-ratchet.json` records the reviewed per-method CRAP ceiling.
`coverage-ratchet.json` is the single source of truth for the Vitest coverage
floors. CI rejects regressions in existing methods, new methods over CRAP 8, a
higher project maximum, additional high-CRAP or unmeasured methods, and lower
coverage floors.

The initial refactor reduced the worst method from CRAP 1122 to 342. The current
report covers 251 methods, with 55 above CRAP 8. The measured whole-project
coverage is 51.99% lines, 49.52% statements, 50% functions, and 40.65% branches;
conservative integer floors are ratcheted to 51%, 49%, 50%, and 40%
respectively. Raise those floors whenever the measured baseline improves.

After genuinely improving complexity or coverage, run `npm run crap:report`
and `npm run crap:baseline`, review the reduction, and commit the lowered
baseline. Raise improved coverage floors directly in `coverage-ratchet.json`.
Never update either baseline merely to make a failing check pass.

`npm run quality:policy` always validates both files and checks that their
summary fields agree with their method data. To compare a local change with a
specific Git base, run:

```bash
npm run quality:policy -- --base-ref origin/master
```

CI supplies the pull-request base SHA or the previous push SHA. When that commit
predates these files, the command treats them as their first introduction;
later changes can only tighten them. Tagged release validation compares against
the tag commit's parent through `npm run validate`.
