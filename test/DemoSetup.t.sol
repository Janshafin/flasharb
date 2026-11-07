// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MakerTraits} from "swap-vm/src/libs/MakerTraits.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";
import {ISwapVMRouter} from "../src/interfaces/ISwapVMRouter.sol";
import {DemoSetup} from "../script/DemoSetup.s.sol";

/// @notice Runs the local demo script inside a test and checks it leaves a real, profitable gap behind.
contract DemoSetupTest is Test {
    DemoSetup internal script;
    DemoSetup.Demo internal d;

    function setUp() public {
        script = new DemoSetup();
        d = script.deploy();
    }

    function _arb(uint128 size, uint128 minProfit) internal view returns (FlashArbExecutor.Arb memory) {
        return FlashArbExecutor.Arb({
            key: d.key,
            zeroForOne: d.weth < d.usdc,
            amountIn: size,
            minProfit: minProfit,
            lastBlock: uint32(block.number),
            profitAsClaim: true,
            order: ISwapVMRouter.Order({
                maker: d.order.maker, traits: MakerTraits.unwrap(d.order.traits), data: d.order.data
            })
        });
    }

    function test_stackIsWiredAndOwned() public view {
        FlashArbExecutor e = FlashArbExecutor(d.executor);
        assertEq(e.OWNER(), d.owner, "the deployer owns the executor");
        assertEq(address(e.POOL_MANAGER()), d.poolManager, "executor points at the PoolManager");
        assertEq(e.ROUTER(), d.router, "executor points at the router");
        assertEq(e.AQUA(), d.aqua, "executor points at Aqua");
        assertGt(d.poolManager.code.length, 0, "PoolManager is deployed");
        assertGt(d.router.code.length, 0, "router is deployed");
    }

    function test_demoLeavesAProfitableGap() public {
        vm.prank(d.owner);
        (bool ok, bytes memory ret) =
            d.executor.call(abi.encodeCall(FlashArbExecutor.arb, (_arb(1e18, type(uint128).max))));
        assertFalse(ok, "a quote reverts by design");
        assertEq(bytes4(ret), FlashArbExecutor.InsufficientProfit.selector, "it reverts with InsufficientProfit");
        uint256 back;
        uint256 owed;
        assembly {
            back := mload(add(ret, 36))
            owed := mload(add(ret, 68))
        }
        assertGt(back, owed, "the demo gap pays");
    }

    function test_demoArbBooksAClaim() public {
        vm.prank(d.owner);
        FlashArbExecutor(d.executor).arb(_arb(1e18, 1));
        uint256 claim = IPoolManager(d.poolManager).balanceOf(d.executor, Currency.wrap(d.weth).toId());
        assertGt(claim, 0, "the arb booked a WETH claim");
    }

    function test_setupRefusesToRunOutsideALocalChain() public {
        vm.chainId(1);
        vm.expectRevert("demo scripts only run on a local chain (31337)");
        script.run();
    }
}
