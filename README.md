# pancakeswap

## Get Started

### Install dependencies
```
pnpm i
pnpm run build
```

### Run the script

```
pnpm run start -- --pk <PRIVATE_KEY> --amount <AMOUNT_A> --fromToken <TOKEN_A> --toToken <TOKEN_B>
```
- example
    ```
    pnpm run start -- --pk 123 --amount 1 --fromToken bnb --toToken cake
    ```
- supported [BSC token](https://github.com/pancakeswap/pancake-frontend/blob/develop/packages/tokens/src/constants/bsc.ts) list

## References
- [routing-sdk](https://github.com/pancakeswap/pancake-frontend/tree/develop/packages/routing-sdk) is not published yet, copy to this repo
- [universal-router-sdk](https://github.com/pancakeswap/pancake-frontend/tree/develop/packages/universal-router-sdk)
