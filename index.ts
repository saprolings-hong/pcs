import { ethers } from "ethers";
import type { PancakeSwapOptions } from "@pancakeswap/universal-router-sdk";
import {
  PancakeSwapUniversalRouter,
  getUniversalRouterAddress,
  type Permit2Signature,
} from "@pancakeswap/universal-router-sdk";
import {
  MaxAllowanceTransferAmount,
  PermitSingle,
  getPermit2Address,
  PERMIT_EXPIRATION,
  PERMIT_SIG_EXPIRATION,
  AllowanceTransfer,
  Permit2ABI,
} from "@pancakeswap/permit2-sdk";
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
  type OnChainProvider,
} from "@pancakeswap/smart-router";
import { bscTokens } from "@pancakeswap/tokens";
import { customBscTokens } from "./config/bscTokens";
import { poolManagerAddressCL } from "./config/contracts";
import { poolIds } from "./config/poolIds";
import { createPublicClient, http, decodeFunctionData, PublicClient, type Address, type Hex, type Chain } from "viem";
import { bsc } from "viem/chains";
import { findBestTrade, type Pool, type TradeWithGraph } from "@pancakeswap/routing-sdk";
import { createV2Pool } from "@pancakeswap/routing-sdk-addon-v2";
import { createV3Pool } from "@pancakeswap/routing-sdk-addon-v3";
import { createInfinityBinPool, createInfinityCLPool } from "@pancakeswap/routing-sdk-addon-infinity";
import { createStablePool } from "@pancakeswap/routing-sdk-addon-stable-swap";
import { poolIdToPoolKey, decodeHooksRegistration, encodeHooksRegistration, CLPoolManagerAbi } from "@pancakeswap/infinity-sdk";
import { decodeUniversalCalldata } from "./utils/calldataDecode";

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
  if (token) {
    return token;
  }

  const customToken = customBscTokens[symbol.toLowerCase() as keyof typeof customBscTokens];
  if (!customToken) {
    throw new Error(`Token not found for symbol: ${symbol}`);
  }
  return customToken;
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

const toDeadline = (expiration: number): number => {
  return Math.floor((Date.now() + expiration) / 1000);
};

export const makePermit = (
  token: Address,
  // as spender
  routerAddress: Address,
  amount: string = MaxAllowanceTransferAmount.toString(),
  nonce = 0
): PermitSingle => {
  return {
    details: {
      token,
      amount,
      expiration: toDeadline(PERMIT_EXPIRATION).toString(),
      nonce,
    },
    spender: routerAddress,
    sigDeadline: toDeadline(PERMIT_SIG_EXPIRATION).toString(),
  };
};

const pancakeRouterAbi = require("./abis/pancakeSwapRouter.json");
const bep20Abi = require("./abis/bep20.json");

// mainnet
const pancakeRouterAddressInBsc = "0xd9c500dff816a1da21a48a732d3498bf09dc9aeb";
const bscRpcUrl = "https://bsc-dataseed.binance.org/";

const getPoolId = (from: string, to: string): Hex | undefined => {
  const key1 = `${from.toLowerCase()}/${to.toLowerCase()}`;
  const key2 = `${to.toLowerCase()}/${from.toLowerCase()}`;
  return poolIds[key1] || poolIds[key2];
};

const executeTransaction = async () => {
  const [privateKey, amount, fromToken, toToken] = getArgs();
  const swapFrom = getTokenBySymbol(fromToken);
  const swapTo = getTokenBySymbol(toToken);
  const amountInput = ethers.parseUnits(amount, 18);

  console.log(`Swap ${amount} ${fromToken} to ${toToken}`);

  const provider = new ethers.JsonRpcProvider(bscRpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const client = createPublicClient({
    chain: bsc,
    transport: http("https://bsc-dataseed.binance.org"),
    batch: {
      multicall: {
        batchSize: 1024 * 200,
        // wait: 16,
      },
    },
    // pollingInterval: 6_000,
  });

  
  const poolId = getPoolId(fromToken, toToken);
  console.log("Pool ID:==========", poolId);
  if (!poolId) {
    throw new Error(`Pool not found for pair ${fromToken}/${toToken}`);
  }
  const poolKey = await poolIdToPoolKey({
    poolId,
    poolType: "CL",
    publicClient: client as any,
  });
  console.log("Pool Key:", poolKey);

  const clPoolManagerContract = new ethers.Contract(poolManagerAddressCL!, CLPoolManagerAbi, wallet);
  const [ sqrtPriceX96,  tick,  protocolFee, lpFee] = await clPoolManagerContract.getSlot0(poolId);
  const liquidity = await clPoolManagerContract.getLiquidity(poolId);

  const pools2 = await InfinityRouter.getInfinityClCandidatePools({
    clientProvider: (() => client) as OnChainProvider,
    currencyA: swapFrom,
    currencyB: swapTo,
  });
  // const filteredPools = pools.filter((pool) => pool.currency0.symbol === "KGEN" || pool.currency1.symbol === "KGEN");
  const pools1 = [{
    ...poolKey,
    currency0: swapFrom,
    currency1: swapTo,
    id: "0xb9b436c3869da550f943d3493e262be84a20e53b22223810eb7aa12acb8b6d34",
    type: PoolType.InfinityCL,
    tickSpacing: poolKey!.parameters.tickSpacing,
    sqrtRatioX96: sqrtPriceX96,
    tick,
    liquidity,
    // protocolFee: BigInt(protocolFee),
    // fee: lpFee,
    hooksRegistration : encodeHooksRegistration(poolKey!.parameters.hooksRegistration),

  } as any]
  const pools = [...pools1, ...pools2]
  console.log(pools);
  
  // const filteredPools = pools.filter((pool) => pool.type === PoolType.InfinityCL);
  // const v3Pools = await InfinityRouter.getV3CandidatePools({
  //   clientProvider: (() => client) as OnChainProvider,
  //   currencyA: swapFrom,
  //   currencyB: swapTo,
  // });
  // const filteredV3Pools = v3Pools.filter(pool =>
  //   pool.token0.symbol === 'KGEN' || pool.token1.symbol === 'KGEN'
  // );
  // console.log(filteredV3Pools);
  const amountIn = CurrencyAmount.fromRawAmount(swapFrom, amountInput);
  // const trade = await InfinityRouter.getBestTrade(amountIn, swapTo, TradeType.EXACT_INPUT, {
  //   gasPriceWei: () => client.getGasPrice(),
  //   candidatePools: v3Pools,
  // });
  // if (!trade) {
  //   throw new Error("Unable to find a valid trade route");
  // }
  // console.log("Trade found via InfinityRouter:", trade);

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

  let permit2Permit: Permit2Signature | undefined;
  if (swapFrom instanceof ERC20Token) {
    const PERMIT2_ADDRESS = getPermit2Address(ChainId.BSC);
    const UNIVERSAL_ROUTER_ADDRESS = getUniversalRouterAddress(ChainId.BSC);
    const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS!, Permit2ABI, wallet);
    const [permit2AllowanceAmount, permit2AllowanceExpiration, permit2AllowanceNonce] = await permit2Contract.allowance(
      wallet.address,
      swapFrom.address,
      UNIVERSAL_ROUTER_ADDRESS
    );

    const permitSingle = makePermit(
      swapFrom!.address,
      UNIVERSAL_ROUTER_ADDRESS,
      amountInput.toString(),
      permit2AllowanceNonce
    );

    const { domain, types, values } = AllowanceTransfer.getPermitData(permitSingle, PERMIT2_ADDRESS, ChainId.BSC);
    const signature = (await wallet.signTypedData(domain, types, values)) as `0x${string}`;

    const erc20Contract = new ethers.Contract(swapFrom.address, bep20Abi, wallet);
    const ecr20Allowance = await erc20Contract.allowance(wallet.address, PERMIT2_ADDRESS);
    // Default ERC20 approve amount 500, reduce the number of approve calls
    const DEFAULT_APPROVE_AMOUNT = ethers.parseUnits("500", swapFrom.decimals);
    const approveAmount = amountInput > DEFAULT_APPROVE_AMOUNT ? amountInput : DEFAULT_APPROVE_AMOUNT;
    if (ecr20Allowance < amountInput) {
      console.log(
        `Current ${swapFrom.symbol} allowance ${ethers.formatUnits(
          ecr20Allowance,
          swapFrom.decimals
        )} is less than amount to swap ${ethers.formatUnits(amountInput, swapFrom.decimals)}`
      );
      const tx = await erc20Contract.approve(PERMIT2_ADDRESS, approveAmount);
      await tx.wait();
      console.log(`${swapFrom.symbol} approve Tx hash:`, tx.hash);
    }

    permit2Permit = {
      ...permitSingle,
      signature,
    };
  }

  const options = permit2Permit ? swapOptions({ inputTokenPermit: permit2Permit }) : swapOptions({});
  const smartRouterTrade = buildInfinityTrade(TradeType.EXACT_INPUT, bestTrade);
  const { calldata, value } = PancakeSwapUniversalRouter.swapERC20CallParameters(smartRouterTrade, options);

  // const { functionName, args } = decodeFunctionData({
  //   abi: pancakeRouterAbi,
  //   data: calldata,
  // });
  // console.log("Calldata:", calldata);
  // console.log("Value:", value);
  // console.log("Function Name:", functionName);
  // console.log("Args:", args);
  // const decodedCommands = decodeUniversalCalldata(calldata);

  // const tx = await wallet.sendTransaction({
  //   to: pancakeRouterAddressInBsc,
  //   data: calldata,
  //   value: value,
  //   gasLimit: 700000n,
  // });

  // const transaction = await tx.wait();
  // console.log("Transaction:", transaction);
};

(async () => {
  await executeTransaction();
})();
