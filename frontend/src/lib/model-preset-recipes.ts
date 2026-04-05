import type { GGUFFileInfo } from "@/lib/api";

export type PresetFamily = "universal" | "dense" | "moe" | "multimodal";

export const PRESET_FAMILY_OPTIONS: Array<{ value: PresetFamily; label: string }> = [
  { value: "universal", label: "Universal" },
  { value: "dense", label: "Dense" },
  { value: "moe", label: "MoE" },
  { value: "multimodal", label: "Multimodal" },
];

export interface LaunchOptionDraft {
  flashAttn: boolean;
  contBatching: boolean;
  mlock: boolean;
  noMmap: boolean;
  noKvOffload: boolean;
  parallelSlots: number;
  threads: number;
  threadsBatch: number;
  cacheTypeK: string;
  cacheTypeV: string;
  tensorSplit: string;
  mmprojPath: string;
  customArgs: string;
}

export interface PresetRecipe {
  key: string;
  label: string;
  family: PresetFamily;
  description: string;
  tags: string[];
  ngl: number;
  batch: number;
  ubatch: number;
  ctx: number;
  options: Partial<LaunchOptionDraft>;
}

export const createDefaultLaunchOptions = (): LaunchOptionDraft => ({
  flashAttn: true,
  contBatching: false,
  mlock: false,
  noMmap: false,
  noKvOffload: false,
  parallelSlots: 1,
  threads: 0,
  threadsBatch: 0,
  cacheTypeK: "",
  cacheTypeV: "",
  tensorSplit: "",
  mmprojPath: "",
  customArgs: "",
});

export const PRESET_RECIPES: PresetRecipe[] = [
  {
    key: "universal-balanced",
    label: "Universal Balanced",
    family: "universal",
    description: "Daily-driver preset that keeps VRAM pressure reasonable while still enabling flash attention.",
    tags: ["shared", "starter"],
    ngl: 999,
    batch: 1024,
    ubatch: 512,
    ctx: 8192,
    options: { flashAttn: true, contBatching: false, parallelSlots: 1 },
  },
  {
    key: "dense-throughput",
    label: "Dense Throughput",
    family: "dense",
    description: "Higher batch sizes for dense instruct models when throughput matters more than latency.",
    tags: ["dense", "fast"],
    ngl: 999,
    batch: 2048,
    ubatch: 512,
    ctx: 8192,
    options: { flashAttn: true, contBatching: true, parallelSlots: 2 },
  },
  {
    key: "dense-long-context",
    label: "Dense Long Context",
    family: "dense",
    description: "More conservative batching so you can stretch context length without immediately choking VRAM.",
    tags: ["dense", "long-context"],
    ngl: 999,
    batch: 768,
    ubatch: 256,
    ctx: 32768,
    options: { flashAttn: true, contBatching: false, parallelSlots: 1 },
  },
  {
    key: "moe-safe",
    label: "MoE Safe",
    family: "moe",
    description: "Smaller batches and KV-offload guardrails for expert-heavy models that spike memory use.",
    tags: ["moe", "stable"],
    ngl: 999,
    batch: 512,
    ubatch: 128,
    ctx: 8192,
    options: { flashAttn: true, contBatching: false, noKvOffload: true, parallelSlots: 1 },
  },
  {
    key: "moe-throughput",
    label: "MoE Throughput",
    family: "moe",
    description: "Keeps MoE routing responsive while opening a bit more concurrency for chat workloads.",
    tags: ["moe", "chat"],
    ngl: 999,
    batch: 768,
    ubatch: 192,
    ctx: 8192,
    options: { flashAttn: true, contBatching: true, noKvOffload: true, parallelSlots: 2 },
  },
  {
    key: "multimodal-chat",
    label: "Vision Chat",
    family: "multimodal",
    description: "Balanced multimodal startup with flash attention and mmproj wiring ready.",
    tags: ["vision", "mmproj"],
    ngl: 999,
    batch: 1024,
    ubatch: 256,
    ctx: 8192,
    options: { flashAttn: true, contBatching: false, parallelSlots: 1 },
  },
];

const FAMILY_KEYWORDS: Record<Exclude<PresetFamily, "universal">, RegExp> = {
  dense: /(llama|mistral|gemma|phi|qwen|yi|deepseek(?!.*moe))/i,
  moe: /(moe|mixtral|gpt-oss|deepseek-r1|deepseek-v3|qwen.*moe)/i,
  multimodal: /(vision|vl|llava|qwen2\.5-vl|multimodal)/i,
};

export const getPresetRecipe = (key: string) =>
  PRESET_RECIPES.find((recipe) => recipe.key === key) ?? PRESET_RECIPES[0];

export const applyPresetRecipe = (
  key: string,
  current: LaunchOptionDraft,
): { recipe: PresetRecipe; options: LaunchOptionDraft } => {
  const recipe = getPresetRecipe(key);
  return {
    recipe,
    options: {
      ...createDefaultLaunchOptions(),
      ...current,
      ...recipe.options,
      mmprojPath: current.mmprojPath,
      customArgs: current.customArgs,
    },
  };
};

export const inferPresetFamily = (model?: (Partial<GGUFFileInfo> & { model_family?: string }) | null): PresetFamily => {
  if (!model) return "universal";
  if (model.model_family && PRESET_FAMILY_OPTIONS.some((option) => option.value === model.model_family)) {
    return model.model_family as PresetFamily;
  }
  if (model.model_type === "multimodal_base") return "multimodal";

  const haystack = `${model.filename ?? ""} ${model.arch ?? ""}`;
  if (FAMILY_KEYWORDS.moe.test(haystack)) return "moe";
  if (FAMILY_KEYWORDS.multimodal.test(haystack)) return "multimodal";
  if (FAMILY_KEYWORDS.dense.test(haystack)) return "dense";
  return "universal";
};

export const inferPresetRecipeKey = (model?: Partial<GGUFFileInfo> | null): string => {
  const family = inferPresetFamily(model);
  if (family === "moe") return "moe-safe";
  if (family === "multimodal") return "multimodal-chat";

  const paramSize = Number.parseFloat(model?.param_size ?? "0");
  if (Number.isFinite(paramSize) && paramSize >= 30) return "dense-long-context";
  if (family === "dense") return "dense-throughput";
  return "universal-balanced";
};

const quoteIfNeeded = (value: string) => (value.includes(" ") ? `"${value}"` : value);

export const buildExtraArgs = (options: LaunchOptionDraft): string => {
  const args: string[] = [];

  if (options.flashAttn) args.push("--flash-attn");
  if (options.contBatching) args.push("--cont-batching");
  if (options.mlock) args.push("--mlock");
  if (options.noMmap) args.push("--no-mmap");
  if (options.noKvOffload) args.push("--no-kv-offload");
  if (options.parallelSlots > 1) args.push("--parallel", String(options.parallelSlots));
  if (options.threads > 0) args.push("--threads", String(options.threads));
  if (options.threadsBatch > 0) args.push("--threads-batch", String(options.threadsBatch));
  if (options.cacheTypeK.trim()) args.push("--cache-type-k", options.cacheTypeK.trim());
  if (options.cacheTypeV.trim()) args.push("--cache-type-v", options.cacheTypeV.trim());
  if (options.tensorSplit.trim()) args.push("--tensor-split", quoteIfNeeded(options.tensorSplit.trim()));
  if (options.mmprojPath.trim()) args.push("--mmproj", quoteIfNeeded(options.mmprojPath.trim()));
  if (options.customArgs.trim()) args.push(options.customArgs.trim());

  return args.join(" ").trim();
};

const tokenizeArgs = (value: string): string[] =>
  value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];

const stripQuotes = (value: string) => value.replace(/^"|"$/g, "");

export const parseExtraArgs = (value: string): LaunchOptionDraft => {
  const draft = createDefaultLaunchOptions();
  const leftovers: string[] = [];
  const tokens = tokenizeArgs(value);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];

    if (token === "--flash-attn") {
      draft.flashAttn = true;
      continue;
    }
    if (token === "--cont-batching") {
      draft.contBatching = true;
      continue;
    }
    if (token === "--mlock") {
      draft.mlock = true;
      continue;
    }
    if (token === "--no-mmap") {
      draft.noMmap = true;
      continue;
    }
    if (token === "--no-kv-offload") {
      draft.noKvOffload = true;
      continue;
    }
    if (token === "--parallel" && next) {
      draft.parallelSlots = Number.parseInt(stripQuotes(next), 10) || 1;
      index += 1;
      continue;
    }
    if (token === "--threads" && next) {
      draft.threads = Number.parseInt(stripQuotes(next), 10) || 0;
      index += 1;
      continue;
    }
    if (token === "--threads-batch" && next) {
      draft.threadsBatch = Number.parseInt(stripQuotes(next), 10) || 0;
      index += 1;
      continue;
    }
    if (token === "--cache-type-k" && next) {
      draft.cacheTypeK = stripQuotes(next);
      index += 1;
      continue;
    }
    if (token === "--cache-type-v" && next) {
      draft.cacheTypeV = stripQuotes(next);
      index += 1;
      continue;
    }
    if (token === "--tensor-split" && next) {
      draft.tensorSplit = stripQuotes(next);
      index += 1;
      continue;
    }
    if (token === "--mmproj" && next) {
      draft.mmprojPath = stripQuotes(next);
      index += 1;
      continue;
    }

    leftovers.push(token);
  }

  draft.customArgs = leftovers.join(" ").trim();
  return draft;
};

export const buildLaunchPreview = (params: {
  runtimeName: string;
  modelPath: string;
  ngl: number;
  batch: number;
  ubatch: number;
  ctx: number;
  extraArgs: string;
}) => {
  const parts = [
    params.runtimeName || "<runtime>",
    "--model",
    params.modelPath || "<model.gguf>",
    "--n-gpu-layers",
    String(params.ngl),
    "--batch-size",
    String(params.batch),
    "--ubatch-size",
    String(params.ubatch),
    "--ctx-size",
    String(params.ctx),
  ];

  if (params.extraArgs.trim()) parts.push(params.extraArgs.trim());
  return parts.join(" ");
};