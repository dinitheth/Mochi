import { MicroSwap } from "generated";

MicroSwap.Swap.handler(async ({ event, context }) => {
  context.Swap.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    sender: event.params.sender,
    tokenIn: event.params.tokenIn,
    amountIn: event.params.amountIn,
    amountOut: event.params.amountOut.toString(),
    to: event.params.to,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
  });
});

MicroSwap.LiquidityAdded.handler(async ({ event, context }) => {
  context.LiquidityAdded.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    provider: event.params.provider,
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    shares: event.params.shares,
    blockNumber: BigInt(event.block.number),
  });
});
