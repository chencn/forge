/**
 * 按字节封顶的输出缓冲。
 *
 * 会话输出是持续到达的，只按块数封顶挡不住真正的大流量：后端一块最多 32KB，
 * 五百块就是 16MB，而且这是「每条会话」的量。这里改成按字节封顶，超了从最老的块开始丢，
 * 保留最近一段——重放时本来也只看得见最后那些行，与 xterm 的滚屏上限对得上。
 *
 * 按整块丢而不是按字节切：一块的边界可能落在转义序列或 UTF-8 多字节字符中间，
 * 从中间切会让重放的头一屏花掉。
 */
export class ChunkBuffer {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;

  public constructor(
    /** 字节上限：超了丢最老的块。 */
    private readonly maxBytes: number,
    /** 块数上限：小块很多时兜住数组本身的长度。 */
    private readonly maxChunks: number
  ) {}

  /** 追加一块；超限时从最老的块开始丢。至少留一块，免得把刚到的输出也丢掉。 */
  public append(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    while (
      this.chunks.length > 1 &&
      (this.bytes > this.maxBytes || this.chunks.length > this.maxChunks)
    ) {
      this.bytes -= this.chunks.shift()?.byteLength ?? 0;
    }
  }

  /**
   * 在最前面补一块（命令行回显）。
   *
   * 不因此裁尾巴：补进来的只有一行，超出的那点由下一次 `append` 顺手收掉，
   * 免得刚补上的那行立刻被自己挤掉。
   */
  public prepend(chunk: Uint8Array): void {
    this.chunks.unshift(chunk);
    this.bytes += chunk.byteLength;
  }

  /** 已经收下的块，从老到新。只读使用，不要在调用方改这个数组。 */
  public toArray(): readonly Uint8Array[] {
    return this.chunks;
  }

  /** 当前占用的字节数（含 prepend 补进来的那行）。 */
  public get byteLength(): number {
    return this.bytes;
  }
}
