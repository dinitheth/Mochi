// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title MicroSwap — minimal constant-product AMM (x*y=k, 0.3% fee) for demos.
/// @notice Demo-grade and unaudited. Interface mirrors Uniswap V2's router
///         subset (getAmountsOut / swapExactTokensForTokens) on purpose so
///         off-chain tooling written for V2 routers works unchanged.
contract MicroSwap {
    address public immutable token0;
    address public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public totalLiquidity;
    mapping(address => uint256) public liquidityOf;

    uint256 private constant FEE_NUM = 997;
    uint256 private constant FEE_DEN = 1000;

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 shares);
    event Swap(address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed to);

    constructor(address _tokenA, address _tokenB) {
        require(_tokenA != _tokenB, "identical tokens");
        require(_tokenA != address(0) && _tokenB != address(0), "zero token");
        (token0, token1) = _tokenA < _tokenB ? (_tokenA, _tokenB) : (_tokenB, _tokenA);
    }

    function getReserves() external view returns (uint256 r0, uint256 r1) {
        return (reserve0, reserve1);
    }

    function quoteOut(address tokenIn, uint256 amountIn) public view returns (uint256 amountOut) {
        require(amountIn > 0, "zero in");
        (uint256 rIn, uint256 rOut) = _reservesFor(tokenIn);
        require(rIn > 0 && rOut > 0, "no liquidity");
        uint256 inWithFee = amountIn * FEE_NUM;
        amountOut = (inWithFee * rOut) / (rIn * FEE_DEN + inWithFee);
        require(amountOut > 0 && amountOut < rOut, "bad quote");
    }

    /// @notice Uniswap-V2-style multi-hop quote (supports [A,B] and [B,A] here).
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2, "only direct pairs");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = quoteOut(path[0], amountIn);
    }

    function addLiquidity(uint256 amount0, uint256 amount1) external returns (uint256 shares) {
        require(amount0 > 0 && amount1 > 0, "zero amounts");
        require(IERC20(token0).transferFrom(msg.sender, address(this), amount0), "t0 pull failed");
        require(IERC20(token1).transferFrom(msg.sender, address(this), amount1), "t1 pull failed");
        if (totalLiquidity == 0) {
            shares = _sqrt(amount0 * amount1);
        } else {
            uint256 s0 = (amount0 * totalLiquidity) / reserve0;
            uint256 s1 = (amount1 * totalLiquidity) / reserve1;
            shares = s0 < s1 ? s0 : s1;
        }
        require(shares > 0, "zero shares");
        totalLiquidity += shares;
        liquidityOf[msg.sender] += shares;
        reserve0 += amount0;
        reserve1 += amount1;
        emit LiquidityAdded(msg.sender, amount0, amount1, shares);
    }

    /// @notice Uniswap-V2-style swap for direct pairs.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "expired");
        require(path.length == 2, "only direct pairs");
        require(to != address(0), "zero recipient");
        address tokenIn = path[0];
        uint256 amountOut = quoteOut(tokenIn, amountIn);
        require(amountOut >= amountOutMin, "slippage");
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        address tokenOut = tokenIn == token0 ? token1 : token0;
        require(IERC20(tokenOut).transfer(to, amountOut), "push failed");
        if (tokenIn == token0) {
            reserve0 += amountIn;
            reserve1 -= amountOut;
        } else {
            reserve1 += amountIn;
            reserve0 -= amountOut;
        }
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
        emit Swap(msg.sender, tokenIn, amountIn, amountOut, to);
    }

    function _reservesFor(address tokenIn) internal view returns (uint256 rIn, uint256 rOut) {
        require(tokenIn == token0 || tokenIn == token1, "unknown token");
        return tokenIn == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
