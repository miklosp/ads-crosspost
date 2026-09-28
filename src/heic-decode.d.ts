declare module "heic-decode" {
  export default function decode(o: { buffer: Uint8Array }): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}
