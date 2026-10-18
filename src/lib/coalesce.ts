/**
 * 把重复触发的异步任务并成「手头那一趟 + 至多一趟补跑」。
 *
 * 用法是每次调用都把自己那份任务函数交进来：队列只认「现在有没有在飞的」，
 * 不认任务的身份，所以任务本身可以随依赖换（换了根目录、换了工作区都行）。
 *
 * 为什么补跑一趟就够、不会丢东西：补跑那一轮是在手头这轮落定之后才起，读到的
 * 必然是最后一次请求之后的状态。中间再来十次请求也只是把欠账标记再按一次。
 */
export interface Coalescer {
  /** 触发一次；已有任务在飞时只记一笔欠账，并把手头那趟回给调用方。 */
  request: (task: () => Promise<void>) => Promise<void>;
  /** 作废排队中的补跑：换工作区那种「旧仓库读回来也不该写进新面板」的场合用。 */
  cancelTrailing: () => void;
}

export function createCoalescer(): Coalescer {
  let live: Promise<void> | null = null;
  let again = false;
  /** 排队期间最后一次交进来的那份任务，补跑用它。 */
  let pending: (() => Promise<void>) | null = null;
  return {
    request(task: () => Promise<void>) {
      if (live) {
        again = true;
        pending = task;
        return live;
      }
      const queue = async () => {
        try {
          for (;;) {
            // 先把欠账清零再跑：跑的过程中来的那一次会把它重新置上，归下一轮。
            again = false;
            const run = pending ?? task;
            pending = null;
            await run();
            if (again) continue;
            return;
          }
        } finally {
          // 交还名额（成功、失败都走到这儿）。收尾时和 `request` 之间没有别的等待点，
          // 所以后来的调用要么并进这一轮，要么另起一轮，不会挂到已收尾的上面。
          live = null;
        }
      };
      const started = queue();
      live = started;
      return started;
    },
    cancelTrailing() {
      again = false;
      pending = null;
    },
  };
}
