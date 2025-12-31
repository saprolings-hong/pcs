import { ChainId } from '@pancakeswap/chains'
import { ERC20Token } from '@pancakeswap/sdk'

export const customBscTokens = {
  kgen: new ERC20Token(
    ChainId.BSC,
    '0xF3d5b4c34Ed623478cc5141861776E6cf7AE3A1E',
    8,
    'KGEN',
    'KGEN',
    'https://kgen.io/',
  ),
}
