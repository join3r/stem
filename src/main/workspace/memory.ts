import type { MemorySettings } from '../../shared/types';
import { readConfig, updateConfig } from './config';

export async function getMemorySettings(): Promise<MemorySettings> {
  const config = await readConfig();
  return {
    enabled: config.features?.memories === true,
    useMemories: config.memories?.use_memories !== false,
    generateMemories: config.memories?.generate_memories !== false
  };
}

export async function setMemoryEnabled(enabled: boolean): Promise<MemorySettings> {
  await updateConfig((config) => {
    config.features = config.features ?? {};
    config.features.memories = enabled;
    config.memories = config.memories ?? {};
    config.memories.use_memories = enabled;
    config.memories.generate_memories = enabled;
  });
  return getMemorySettings();
}
