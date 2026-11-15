# ontology-rsi-toolkit

An RSI toolkit for [PenguinHarness](https://github.com/Prism-Shadow/penguin-harness). It learns a typed model of an agent's working domain (entities, relations, lifecycles, source precedence, action contracts, constraints) from the agent's own runs. Each policy rule is tested by editing the answer fields it decides and asking the training judge, then kept only if fresh agents reading it reproduce the gain.

GDPevo-essential, DeepSeek-V4.1-Flash-1017: six-group test mean 56.32 (baseline) → 67.78 ± 0.60. Details in [DESIGN.md](DESIGN.md) · [中文](DESIGN.zh.md).

## Install

```bash
penguin plugin install https://github.com/EonHao/ontology-rsi-toolkit/releases/download/v0.1.0/ontology-rsi-toolkit-0.1.0.tgz
```

Then install the plugin on the agent that will run experiments. It appears under **Method** in the Evaluation Center's Optimize tab.

## Use

From the Optimize tab, or by prompt:

```text
Use the ontology-rsi-toolkit Skill to train on Benchmark
gdpevo-essential-coverage-review-train, then test the frozen ontology on
gdpevo-essential-coverage-review-test.
```

The Skill prepares the States, runs one training trial in a Harbor container, freezes the learned `skills/domain-ontology/` and runs the test matrix. It needs a benchmark whose training judge scores submitted answers.

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Card and Skill contribution; `pnpm build` writes `ifaces.json` |
| `skills/ontology-rsi-toolkit/SKILL.md` | Organizer: prepare, train, freeze, test, report |
| `skills/ontology-rsi-toolkit/references/` | Benchmark resolution, initialization, training loop, edit format, shared evaluation reference |
| `skills/ontology-rsi-toolkit/scripts/onto.mjs` | Slot, gates and records. Node built-ins only |
| `test/` | `pnpm test` |

## Build

`ifaces.json` is generated with the harness's generator, so the build needs a [penguin-harness](https://github.com/Prism-Shadow/penguin-harness) checkout with dependencies installed:

```bash
pnpm install
PENGUIN_HARNESS=/path/to/penguin-harness pnpm build
pnpm test
```

## License

[Apache-2.0](LICENSE)
