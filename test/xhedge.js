const timeMachine = require('ganache-time-traveler');
const truffleAssert = require('truffle-assertions');

const XHedge = artifacts.require("XHedge");
const Oracle = artifacts.require("MockOracle");

contract("XHedge", async (accounts) => {

    // accounts
    const oven  = accounts[0];
    const alice = accounts[1];
    const lula  = accounts[2];
    const hari  = accounts[3];

    const _1e18              = 10n ** 18n;
    const initOraclePrice    = 600n * _1e18;
  
    // default createVault() args
    const initCollateralRate = _1e18 / 2n; // 0.5
    const minCollateralRate  = _1e18 / 5n; // 0.2
    const closeoutPenalty    = _1e18 / 100n; // 0.01
    const matureTime         = Math.floor(Date.now() / 1000) + 30 * 60; // 30m
    const validatorToVote    = 1;
    const hedgeValue         = 600n * _1e18;
    const amt                = (_1e18 + initCollateralRate) * hedgeValue / initOraclePrice; // 1.5e18

    let gasPrice;
    let oracle;
    let xhedge;

    before(async () => {
        gasPrice = await web3.eth.getGasPrice();
    });

    beforeEach(async () => {
        let snapshot = await timeMachine.takeSnapshot();
        snapshotId = snapshot['result'];

        oracle = await Oracle.new(initOraclePrice, { from: oven });
        xhedge = await XHedge.new({ from: oven });
        hedger = (await web3.eth.accounts.create()).address;
        speculator = (await web3.eth.accounts.create()).address;
    });

    afterEach(async() => {
        await timeMachine.revertToSnapshot(snapshotId);
    });

    it('createVault', async () => {
        const balance0 = await web3.eth.getBalance(alice);
        const result = await createVaultWithDefaultArgs();
        const balance1 = await web3.eth.getBalance(alice);

        const gasFee = getGasFee(result, gasPrice);
        assert.equal(BigInt(balance0) - BigInt(balance1), BigInt(gasFee) + amt);

        assert.equal(await xhedge.balanceOf(alice), 2);
        const [leverId, hedgeId, sn] = getTokenIds(result);
        // console.log(leverId, hedgeId, sn);
        assert.equal(await xhedge.ownerOf(leverId), alice);
        assert.equal(await xhedge.ownerOf(hedgeId), alice);

        const vault = await xhedge.snToVault(sn);
        assert.equal(vault.initCollateralRate, initCollateralRate);
        assert.equal(vault.minCollateralRate, minCollateralRate);
        assert.equal(vault.closeoutPenalty, closeoutPenalty);
        assert.equal(vault.matureTime, matureTime);
        assert.equal(vault.validatorToVote, validatorToVote);
        assert.equal(vault.hedgeValue, hedgeValue);
        assert.equal(vault.oracle, oracle.address);
        assert.equal(vault.amount, amt);
    });

    it('createVault_msgValNotEnough', async () => {
        await truffleAssert.reverts(
            createVaultWithDefaultArgs({amt: amt - 100n}),
            "NOT_ENOUGH_PAID"
        );
    });

    it('createVault_lockedAmtTooSmall', async () => {
        const hedgeValue = 600n * _1e18 / (100000n);
        const amt = (_1e18 + initCollateralRate) * hedgeValue / initOraclePrice; // 1.5e13
        await truffleAssert.reverts(
            createVaultWithDefaultArgs({hedgeValue: hedgeValue, amt: amt}),
            "LOCKED_AMOUNT_TOO_SMALL"
        );
    });

    it('burn', async () => {
        const result0 = await createVaultWithDefaultArgs();
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        // console.log(leverId, hedgeId, sn);

        const balance0 = await web3.eth.getBalance(alice);
        const result1 = await xhedge.burn(sn, { from: alice });
        const balance1 = await web3.eth.getBalance(alice);

        const gasFee = getGasFee(result1, gasPrice);
        assert.equal(BigInt(balance1) - BigInt(balance0), amt - BigInt(gasFee));
        assert.equal(await xhedge.balanceOf(alice), 0);
    });

    it('burn_badSN', async () => {
        await truffleAssert.reverts(
            xhedge.burn(123456789), "VAULT_NOT_FOUND"
        );
    });
    it('burn_notWholeOwner', async () => {
        const result0 = await createVaultWithDefaultArgs();
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await xhedge.transferFrom(alice, lula, leverId, { from: alice });
        await truffleAssert.reverts(
            xhedge.burn(sn, { from: alice }), "NOT_WHOLE_OWNER"
        );
        await truffleAssert.reverts(
            xhedge.burn(sn, { from: lula }), "NOT_WHOLE_OWNER"
        );
    });

    it('closeout', async () => {
        const result0 = await createVaultWithDefaultArgs();
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        // console.log(leverId, hedgeId, sn);

        await xhedge.transferFrom(alice, lula, leverId, { from: alice });
        await oracle.setPrice(450n * _1e18, { from: oven });

        const balanceOfAlice0 = await web3.eth.getBalance(alice);
        const balanceOfLula0 = await web3.eth.getBalance(lula);
        const result = await xhedge.closeout(hedgeId, { from: alice });
        const gasFee = getGasFee(result, gasPrice);
        const balanceOfAlice1 = await web3.eth.getBalance(alice);
        const balanceOfLula1 = await web3.eth.getBalance(lula);

        // console.log(BigInt(balanceOfAlice1) - BigInt(balanceOfAlice0) + BigInt(gasFee));
        // console.log(BigInt(balanceOfLula1) - BigInt(balanceOfLula0));
        const amtToHedger = hedgeValue / 450n * (_1e18 + closeoutPenalty) / _1e18;
        assert.equal(BigInt(balanceOfAlice1) - BigInt(balanceOfAlice0) + BigInt(gasFee), amtToHedger);
        assert.equal(BigInt(balanceOfLula1) - BigInt(balanceOfLula0), amt - amtToHedger);
        assert.equal(await xhedge.balanceOf(alice), 0);
    });

    it('closeout_notOwner', async () => {
        const result0 = await createVaultWithDefaultArgs();
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await truffleAssert.reverts(
            xhedge.closeout(hedgeId, { from: lula }), "NOT_OWNER"
        );
    });
    it('closeout_notHedge', async () => {
        const result0 = await createVaultWithDefaultArgs();
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await truffleAssert.reverts(
            xhedge.closeout(leverId, { from: alice }), "NOT_HEDGE_NFT"
        );
    });
    it('closeout_alreadyMature', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await truffleAssert.reverts(
            xhedge.closeout(hedgeId, { from: alice }), "ALREADY_MATURE"
        );
    });
    it('closeout_priceTooHigh', async () => {
        const result0 = await createVaultWithDefaultArgs();
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await truffleAssert.reverts(
            xhedge.closeout(hedgeId, { from: alice }), "PRICE_TOO_HIGH"
        );
    });

    it('liquidate_priceFall_byHedgeOwner', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        // console.log(leverId, hedgeId, sn);

        await xhedge.transferFrom(alice, lula, leverId, { from: alice });
        await oracle.setPrice(500n * _1e18, { from: oven });

        const balanceOfAlice0 = await web3.eth.getBalance(alice);
        const balanceOfLula0 = await web3.eth.getBalance(lula);
        const result = await xhedge.liquidate(hedgeId, { from: alice });
        const gasFee = getGasFee(result, gasPrice);
        const balanceOfAlice1 = await web3.eth.getBalance(alice);
        const balanceOfLula1 = await web3.eth.getBalance(lula);

        // console.log(BigInt(balanceOfAlice1) - BigInt(balanceOfAlice0) + BigInt(gasFee)); // 1.2e18
        // console.log(BigInt(balanceOfLula1) - BigInt(balanceOfLula0));                    // 0.3e18
        const amtToHedger = hedgeValue / 500n;
        assert.equal(BigInt(balanceOfAlice1) - BigInt(balanceOfAlice0) + BigInt(gasFee), amtToHedger);
        assert.equal(BigInt(balanceOfLula1) - BigInt(balanceOfLula0), amt - amtToHedger);
        assert.equal(await xhedge.balanceOf(alice), 0);
    });

    it('liquidate_priceRise_byLeverOwner', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        // console.log(leverId, hedgeId, sn);

        await xhedge.transferFrom(alice, lula, leverId, { from: alice });
        await oracle.setPrice(800n * _1e18, { from: oven });

        const balanceOfAlice0 = await web3.eth.getBalance(alice);
        const balanceOfLula0 = await web3.eth.getBalance(lula);
        const result = await xhedge.liquidate(leverId, { from: lula });
        const gasFee = getGasFee(result, gasPrice);
        const balanceOfAlice1 = await web3.eth.getBalance(alice);
        const balanceOfLula1 = await web3.eth.getBalance(lula);

        // console.log(BigInt(balanceOfAlice1) - BigInt(balanceOfAlice0));                // 0.75e18
        // console.log(BigInt(balanceOfLula1) - BigInt(balanceOfLula0) + BigInt(gasFee)); // 0.75e18
        const amtToHedger = hedgeValue / 800n;
        assert.equal(BigInt(balanceOfAlice1) - BigInt(balanceOfAlice0), amtToHedger);
        assert.equal(BigInt(balanceOfLula1) - BigInt(balanceOfLula0) + BigInt(gasFee), amt - amtToHedger);
        assert.equal(await xhedge.balanceOf(alice), 0);
    });

    it('liquidate_notMature', async () => {
        const result0 = await createVaultWithDefaultArgs();
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await truffleAssert.reverts(
            xhedge.liquidate(leverId, { from: alice }), "NOT_MATURE"
        );
        await truffleAssert.reverts(
            xhedge.liquidate(hedgeId, { from: alice }), "NOT_MATURE"
        );
    });

    it('changeAmt_increase', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        // console.log(leverId, hedgeId, sn);

        await xhedge.transferFrom(alice, lula, leverId, { from: alice });

        const addedAmt = _1e18 / 10n;  // 0.1e18
        const newAmt = amt + addedAmt; // 1.6e18
        const balanceOfAlice0 = await web3.eth.getBalance(alice);
        const result = await xhedge.changeAmount(sn, newAmt, { from: alice, value: addedAmt.toString() });
        const balanceOfAlice1 = await web3.eth.getBalance(alice);
        const gasFee = getGasFee(result, gasPrice);
        assert.equal(BigInt(balanceOfAlice0) - BigInt(balanceOfAlice1) - BigInt(gasFee), addedAmt);
    
        const vault = await xhedge.snToVault(sn);
        assert.equal(vault.amount, newAmt);
    });

    it('changeAmt_decrease', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        // console.log(leverId, hedgeId, sn);

        await xhedge.transferFrom(alice, lula, leverId, { from: alice });
        await oracle.setPrice(900n * _1e18, { from: oven });

        const cutAmt = _1e18 / 10n;  // 0.1e18
        const newAmt = amt - cutAmt; // 1.4e18
        const balanceOfLula0 = await web3.eth.getBalance(lula);
        const result = await xhedge.changeAmount(sn, newAmt, { from: lula });
        const balanceOfLula1 = await web3.eth.getBalance(lula);
        const gasFee = getGasFee(result, gasPrice);
        assert.equal(BigInt(balanceOfLula1) - BigInt(balanceOfLula0) + BigInt(gasFee), 
            cutAmt * 995n / 1000n);

        const vault = await xhedge.snToVault(sn);
        assert.equal(vault.amount, newAmt);
    });

    it('changeAmt_badSN', async () => {
        await truffleAssert.reverts(
            xhedge.changeAmount(123456789, 100, { from: alice }), "VAULT_NOT_FOUND"
        );
    });
    it('changeAmt_increase_badMsgVal', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await truffleAssert.reverts(
            xhedge.changeAmount(sn, amt + 100n, { from: alice, value: 99 }),
            "BAD_MSG_VAL"
        );
        await truffleAssert.reverts(
            xhedge.changeAmount(sn, amt + 100n, { from: alice, value: 101 }),
            "BAD_MSG_VAL"
        );
    });
    it('changeAmt_decrease_notLeverOwner', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await xhedge.transferFrom(alice, lula, leverId, { from: alice });
        await truffleAssert.reverts(
            xhedge.changeAmount(sn, amt - 100n, { from: alice, value: 101 }),
            "NOT_OWNER"
        );
    });
    it('changeAmt_decrease_amtNotEnough', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);

        await xhedge.transferFrom(alice, lula, leverId, { from: alice });

        const cutAmt = _1e18 / 2n;   // 0.5e18
        const newAmt = amt - cutAmt; // 1.0e18
        await truffleAssert.reverts(
            xhedge.changeAmount(sn, newAmt, { from: lula }),
            "AMT_NOT_ENOUGH"
        );
    });

    it('changeValidatorToVote', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        // console.log(leverId, hedgeId, sn);

        await xhedge.transferFrom(alice, lula, leverId, { from: alice });
        await xhedge.changeValidatorToVote(leverId, 123, { from: lula });

        const vault = await xhedge.snToVault(sn);
        assert.equal(vault.validatorToVote, 123);
    });

    it('changeValidatorToVote_notLeverNFT', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await truffleAssert.reverts(
            xhedge.changeValidatorToVote(hedgeId, 123, { from: alice }),
            "NOT_LEVER_NFT"
        );
    });
    it('changeValidatorToVote_notOwner', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await truffleAssert.reverts(
            xhedge.changeValidatorToVote(leverId, 123, { from: lula }),
            "NOT_OWNER"
        );
    });

    it('vote', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        // console.log(leverId, hedgeId, sn);

        const voteTime0 = (await xhedge.snToVault(sn)).lastVoteTime;
        await timeMachine.advanceTime(500 * 24 * 3600);
        await xhedge.vote(sn);
        const voteTime1 = (await xhedge.snToVault(sn)).lastVoteTime;
        assert.equal(await xhedge.valToVotes(1), 
            (BigInt(voteTime1.toString()) - BigInt(voteTime0.toString())) * amt);
    });

    it('vote_minVotes', async () => {
        const result0 = await createVaultWithDefaultArgs({matureTime: 1});
        const [leverId, hedgeId, sn] = getTokenIds(result0);
        await truffleAssert.reverts(
            xhedge.vote(sn), "NOT_ENOUGH_VOTES_FOR_NEW_VAL"
        );
    });

    async function createVaultWithDefaultArgs(args) {
        let _matureTime = args && args.matureTime || matureTime;
        let _hedgeValue = args && args.hedgeValue || hedgeValue;
        let _amt = args && args.amt || amt;

        return await xhedge.createVault(
            initCollateralRate.toString(),
            minCollateralRate.toString(),
            closeoutPenalty.toString(),
            _matureTime,
            validatorToVote,
            _hedgeValue.toString(),
            oracle.address,
            { from: alice, value: _amt.toString() }
        );
    }

});

function getGasFee(result, gasPrice) {
    return result.receipt.gasUsed * gasPrice;
}

function getTokenIds(result) {
    const logs = result.logs.filter(log => log.event == 'Transfer');
    assert.lengthOf(logs, 2);
    return [
        logs[0].args.tokenId.toString(), // LeverNFT
        logs[1].args.tokenId.toString(), // HedgeNFT
        logs[0].args.tokenId >> 1,       // sn
    ];
}
