export type ComponentEntry = {
  name: string;
  filePath: string;
  exportType: 'named' | 'default';
  category?: string;
  routes?: string[];
};

export type ComponentManifest = {
  version: 1;
  scannedAt: number;
  components: ComponentEntry[];
};
