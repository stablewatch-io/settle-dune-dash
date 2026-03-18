declare module 'ethereum-block-by-date' {
  import type { JsonRpcProvider } from 'ethers';

  interface BlockResult {
    date: string;
    block: number;
    timestamp: number;
  }

  class EthDater {
    constructor(provider: JsonRpcProvider);
    getDate(date: Date | string, after?: boolean, refresh?: boolean): Promise<BlockResult>;
    getEvery(duration: string, start: Date | string, end: Date | string, every?: number, after?: boolean): Promise<BlockResult[]>;
  }

  export default EthDater;
}
