import { ethers } from "ethers";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import type { PancakeSwapOptions } from "@pancakeswap/universal-router-sdk";
import { PancakeSwapUniversalRouter } from "@pancakeswap/universal-router-sdk";
import { Percent, Native, ChainId, CurrencyAmount, TradeType, ERC20Token } from "@pancakeswap/sdk";
import {
  InfinityRouter,
  PoolType,
  SmartRouterTrade,
  RouteType,
  SmartRouter,
  Pool as SmartRouterPool,
  InfinityBinPool,
  InfinityClPool,
  type Route,
} from "@pancakeswap/smart-router";
import { bscTokens } from "@pancakeswap/tokens";
import {
  createPublicClient,
  http,
  decodeAbiParameters,
  decodeFunctionData,
} from "viem";
import { bsc } from "viem/chains";
import { findBestTrade, type Pool, type TradeWithGraph } from "@pancakeswap/routing-sdk";
import { createV2Pool } from "@pancakeswap/routing-sdk-addon-v2";
import { createV3Pool } from "@pancakeswap/routing-sdk-addon-v3";
import {
  createInfinityBinPool,
  createInfinityCLPool
} from "@pancakeswap/routing-sdk-addon-infinity";
import { createStablePool } from "@pancakeswap/routing-sdk-addon-stable-swap";

const getArgs = () => {
  const flags = ["--pk", "--amount", "--fromToken", "--toToken"];
  const args: any[] = [];

  flags.forEach((flag) => {
    const index = process.argv.indexOf(flag);
    if (index === -1) {
      throw new Error(`Missing required argument for flag: ${flag}`);
    }

    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for flag: ${flag}`);
    }

    args.push(value);
  });

  return args;
};

const getTokenBySymbol = (symbol: string): ERC20Token | Native => {
  if (symbol.toLowerCase() === "bnb") {
    return Native.onChain(ChainId.BSC);
  }

  const token = bscTokens[symbol.toLowerCase() as keyof typeof bscTokens];
  if (!token) {
    throw new Error(`Token not found for symbol: ${symbol}`);
  }
  return token;
};

const swapOptions = (options: Partial<PancakeSwapOptions>): PancakeSwapOptions => {
  let slippageTolerance = new Percent(5, 100);
  if (options.fee) slippageTolerance = slippageTolerance.add(options.fee.fee);
  return {
    slippageTolerance,
    deadlineOrPreviousBlockhash: BigInt(Math.floor(Date.now() / 1000) + 60 * 5),
    ...options,
  };
};

export function toRoutingSDKPool(p: SmartRouterPool): Pool {
  if (SmartRouter.isV3Pool(p)) {
    return createV3Pool(p);
  }
  if (SmartRouter.isV2Pool(p)) {
    return createV2Pool(p);
  }
  if (SmartRouter.isStablePool(p)) {
    return createStablePool(p);
  }
  if (SmartRouter.isInfinityClPool(p)) {
    return createInfinityCLPool(p);
  }
  if (SmartRouter.isInfinityBinPool(p)) {
    return createInfinityBinPool(p);
  }
  throw new Error(`Unsupported pool type: ${p}`);
}

export const buildInfinityTrade = (
  tradeType: TradeType,
  trade: TradeWithGraph<TradeType>,
  pools?: (InfinityClPool | InfinityBinPool)[]
): Omit<SmartRouterTrade<TradeType>, "gasEstimate"> => {
  const isInfinityCL = trade.routes.every((route) => route.pools.every((pool) => pool.type === PoolType.InfinityCL));
  const isInfinityBin = trade.routes.every((route) => route.pools.every((pool) => pool.type === PoolType.InfinityBIN));
  const routeType = isInfinityCL ? RouteType.InfinityCL : isInfinityBin ? RouteType.InfinityBIN : RouteType.MIXED;
  return {
    ...trade,
    tradeType,
    routes: trade.routes.map(
      (route) =>
        ({
          ...route,
          type: routeType,
          pools: route.pools.map((pool) => ({
            ...pool.getPoolData(),
            ...pool,
            type: PoolType[pool.type as keyof typeof PoolType],
          })),
        } as Route)
    ),
  };
};

const pancakeRouterAbi = require("./abis/pancakeSwapRouter.json");
const bep20Abi = require("./abis/bep20.json");

// mainnet
const pancakeRouterAddressInBsc = "0xd9c500dff816a1da21a48a732d3498bf09dc9aeb";
const cakeTokenAddressInBsc = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const bscRpcUrl = "https://bsc-dataseed.binance.org/";

const executeTransaction = async () => {
  const [privateKey, amount, fromToken, toToken] = getArgs();
  const swapFrom = getTokenBySymbol(fromToken);
  const swapTo = getTokenBySymbol(toToken);
  const amountInput = parseUnits(amount, 18);

  console.log(`Swap ${amount} ${fromToken} to ${toToken}`);

  const provider = new ethers.providers.JsonRpcProvider(bscRpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  // const bnbBalance = await provider.getBalance(wallet.address);
  // console.log(`BNB Balance: ${formatUnits(bnbBalance, 18)}`);
  // const signer = provider.getSigner(wallet.address);
  // const cakeTokenContract = new ethers.Contract(cakeTokenAddressInBsc, bep20Abi, provider);
  // const cakeBalance = await cakeTokenContract.balanceOf(wallet.address);
  // console.log(`CAKE Balance: ${formatUnits(cakeBalance, 18)}`);

  const client = createPublicClient({
    chain: bsc,
    transport: http("https://bsc-dataseed.binance.org"),
    batch: {
      multicall: {
        batchSize: 1024 * 200,
      },
    },
  });
  // const chainId = ChainId.BSC;
  // const swapFrom = Native.onChain(chainId);
  // const swapTo = bscTokens.cake;
  const pools = await InfinityRouter.getInfinityCandidatePools({
    clientProvider: () => client,
    currencyA: swapFrom,
    currencyB: swapTo,
  });
  // const v3Pools = await InfinityRouter.getV3CandidatePools({
  //   clientProvider: () => client,
  //   currencyA: swapFrom,
  //   currencyB: swapTo,
  // });
  // const trade = await InfinityRouter.getBestTrade(amountIn, swapTo, TradeType.EXACT_INPUT, {
  //   gasPriceWei: () => client.getGasPrice(),
  //   candidatePools: v3Pools,
  // });
  // if (!trade) {
  //   throw new Error("Unable to find a valid trade route");
  // }

  const amountIn = CurrencyAmount.fromRawAmount(swapFrom, amountInput.toBigInt());
  const bestTrade = await findBestTrade({
    amount: amountIn,
    quoteCurrency: swapTo,
    tradeType: TradeType.EXACT_INPUT,
    candidatePools: pools.map(toRoutingSDKPool),
    gasPriceWei: () => client.getGasPrice(),
  });

  if (!bestTrade) {
    throw new Error("Unable to find a valid trade route");
  }

  const options = swapOptions({});
  const smartRouterTrade = buildInfinityTrade(TradeType.EXACT_INPUT, bestTrade);
  const { calldata, value } = PancakeSwapUniversalRouter.swapERC20CallParameters(smartRouterTrade, options);
  const { functionName, args } = decodeFunctionData({
    abi: pancakeRouterAbi,
    data: calldata,
  });

  // console.log("Calldata:", calldata)
  // console.log("Value:", value)
  // console.log("Function Name:", functionName);
  // console.log("Args:", args);

  const tx = await wallet.sendTransaction({
    to: pancakeRouterAddressInBsc,
    data: calldata,
    value: value,
    gasLimit: ethers.BigNumber.from(700000),
  });

  const receipt = await tx.wait();
  console.log("Transaction:", receipt);
};

(async () => {
  await executeTransaction();
})();
