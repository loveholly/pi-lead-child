// The text about Lead's own token budget raises (ticket #562, budget-raise.ts): the "Lead 动态" sentence and the undo button,
// written in the language the user had chosen. The block* and undo* reasons go to Lead only, so they stay in Chinese.
import { defineMessages } from "@pi-lead-child/protocol";

const tokens = (value: number) => value.toLocaleString("en-US");

export const budgetMessages = defineMessages({
  en: {
    raised: (leadName: string, ticketId: number, from: number, to: number, reason: string) =>
      `${leadName} raised the token budget of ticket #${ticketId} from ${tokens(from)} to ${tokens(to)}.${reason ? ` Reason: ${reason}` : ""}`,
    undone: (by: string | null, leadName: string, ticketId: number, from: number, to: number) =>
      `${by ?? "You"} undid ${leadName}'s budget raise on ticket #${ticketId}: ${tokens(from)} back to ${tokens(to)}.`,
    undo: "Undo",
    blockUsd: "This changes the USD budget. Lead can raise only the token budget on its own",
    blockClear: "This clears the token budget or does not set one. Only the user can remove the limit",
    blockNoBudget: "The ticket has no token budget yet. Only the user sets the first budget",
    blockLower: "This lowers the token budget or keeps it the same. Only a raise can go without the user",
    blockTooMuch: (current: number, ceiling: number) =>
      `This raises the token budget by more than 50% of ${tokens(current)}. On your own you can set at most ${tokens(ceiling)}`,
    undoDone: "This raise was already undone",
    undoGone: "The ticket no longer exists",
    undoChanged: (now: number | null) =>
      `The budget changed again after this raise (now ${now === null ? "no limit" : tokens(now)}). Set it in the ticket details`,
  },
  zh: {
    raised: (leadName, ticketId, from, to, reason) =>
      `${leadName} 把工单 #${ticketId} 的 token 预算从 ${tokens(from)} 调到 ${tokens(to)}。${reason ? `依据：${reason}` : ""}`,
    undone: (by, leadName, ticketId, from, to) =>
      `${by ? `${by} ` : "你"}撤销了 ${leadName} 对工单 #${ticketId} 的预算调整：从 ${tokens(from)} 改回 ${tokens(to)}。`,
    undo: "撤销",
    blockUsd: "这次改的是 USD 预算。你自己只能调高 token 预算",
    blockClear: "这次清掉了 token 预算，或者没给 token 预算。去掉上限只有用户能做",
    blockNoBudget: "这张工单还没有 token 预算。第一次设预算只有用户能做",
    blockLower: "这次是调低 token 预算，或者没有变。只有调高才不用用户",
    blockTooMuch: (current, ceiling) => `这次加幅超过当前预算 ${tokens(current)} 的 50%。你自己最多能调到 ${tokens(ceiling)}`,
    undoDone: "这次调整已经撤销过了",
    undoGone: "这张工单已经不在了",
    undoChanged: (now) => `这次调整以后预算又改过（现在是 ${now === null ? "不限" : tokens(now)}），请在工单详情里直接设预算`,
  },
});
