import { Component } from "@prismshadow/penguin-core/plugin";
import type { Plugin } from "@prismshadow/penguin-core/plugin";

/**
 * Everything this plugin carries, declared for the plugin library. Data only: the class has no
 * body and the package no entry point; `build` writes this literal into `ifaces.json`.
 *
 * The package ships the experiment controller and nothing learned. The ontology itself lives in
 * the Target's own State (`skills/domain-ontology/`), which the controller creates, so that a
 * reinstall of this plugin never replaces what an agent has learned.
 */
@Component({
  contributes: {
    "PluginLibraryModule.cards": [
      {
        id: "ontology-rsi-toolkit.card",
        title: "Ontology RSI Toolkit",
        titleZh: "本体自进化工具包",
        descriptionZh:
          "本体 RSI 工具包：从 Agent 自己的执行轨迹中学习其工作领域的类型化模型（实体、关系、生命周期、数据源优先级、动作契约、约束），每条修改都须逐字引用轨迹并通过确定性校验，冻结后在独立测试上评测。",
        shortDescription: "Ontology RSI Toolkit: learn a typed domain model from Traces.",
        shortDescriptionZh: "本体 RSI 工具包：从轨迹中学习类型化的领域模型。",
        category: "rsi",
        icon: "icon.svg",
        preinstall: false,
        quickStart: {
          prompt:
            "Use the Ontology RSI Toolkit on the selected Project Benchmarks with the requested model and budget.",
          promptZh: "使用本体 RSI 工具包，按指定模型和预算完成选定 Project Benchmark 的实验。",
          skills: ["ontology-rsi-toolkit"],
        },
        references: ["https://github.com/EonHao/ontology-rsi-toolkit/blob/main/DESIGN.md"],
      },
    ],
    "PluginLibraryModule.skills": [
      {
        id: "ontology-rsi-toolkit.skill.ontology-rsi-toolkit",
        name: "ontology-rsi-toolkit",
        path: "skills/ontology-rsi-toolkit",
      },
    ],
  },
})
export class OntologyRsiToolkitPlugin {}

const plugin: Plugin = { modules: [OntologyRsiToolkitPlugin] };
export default plugin;

/**
 * The plugin index reads this named export statically to check the entry contract; the
 * harness's own loader uses the default export above.
 */
export function activate(): Plugin {
  return plugin;
}
