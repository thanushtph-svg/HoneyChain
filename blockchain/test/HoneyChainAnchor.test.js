const { expect } = require('chai');
const { ethers } = require('hardhat');
const crypto = require('node:crypto');

const sha = (s) => '0x' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');

describe('HoneyChainAnchor', () => {
  let c, owner, stranger;
  const key = sha('honeychain|LAB_REPORT|LAB-2026-000045');
  // test vector from docs/06-blockchain-hashing-spec.md
  const hash = '0xd33ca2e7547e1d17afa06427a2d91073e4fcbed267ab5cdfad91df17db9d2093';

  beforeEach(async () => {
    [owner, stranger] = await ethers.getSigners();
    c = await (await ethers.getContractFactory('HoneyChainAnchor')).deploy();
  });

  it('record key matches the documented test vector', () => {
    expect(key).to.equal('0xb3a2ef7b7bf86228dfb2b64934c85aa884e3d91e98fe8b17622970790960c8b6');
  });

  it('deployer is owner and anchorer', async () => {
    expect(await c.owner()).to.equal(owner.address);
    expect(await c.isAnchorer(owner.address)).to.equal(true);
  });

  it('anchors a hash and returns it as latest', async () => {
    await expect(c.anchor(key, hash, 1)).to.emit(c, 'RecordAnchored').withArgs(key, hash, 1, 0, owner.address);
    const a = await c.latest(key);
    expect(a.recordHash).to.equal(hash);
    expect(a.scheme).to.equal(1n);
    expect(await c.versionCount(key)).to.equal(1n);
  });

  it('keeps an append-only history', async () => {
    const h2 = sha('changed');
    await c.anchor(key, hash, 1);
    await c.anchor(key, h2, 1);
    expect(await c.versionCount(key)).to.equal(2n);
    expect((await c.anchorAt(key, 0)).recordHash).to.equal(hash);
    expect((await c.latest(key)).recordHash).to.equal(h2);
  });

  it('rejects anchoring by non-anchorers', async () => {
    await expect(c.connect(stranger).anchor(key, hash, 1)).to.be.revertedWithCustomError(c, 'NotAnchorer');
  });

  it('rejects zero key/hash/scheme', async () => {
    await expect(c.anchor(ethers.ZeroHash, hash, 1)).to.be.revertedWithCustomError(c, 'ZeroValue');
    await expect(c.anchor(key, ethers.ZeroHash, 1)).to.be.revertedWithCustomError(c, 'ZeroValue');
    await expect(c.anchor(key, hash, 0)).to.be.revertedWithCustomError(c, 'ZeroValue');
  });

  it('reverts latest() for unknown records', async () => {
    await expect(c.latest(sha('nothing'))).to.be.revertedWithCustomError(c, 'NoAnchor');
  });

  it('only the owner manages anchorers', async () => {
    await expect(c.connect(stranger).setAnchorer(stranger.address, true)).to.be.revertedWithCustomError(c, 'NotOwner');
    await c.setAnchorer(stranger.address, true);
    await expect(c.connect(stranger).anchor(key, hash, 1)).to.emit(c, 'RecordAnchored');
  });
});
