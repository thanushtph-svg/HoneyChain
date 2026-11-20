// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HoneyChainAnchor
/// @notice Stores SHA-256 hashes of selected HoneyChain records (lab reports, processing records,
///         delivered shipments, batch origins). Only hashes are stored - never names, emails or
///         raw data. The history per record is append-only: nothing can be edited or deleted.
/// @dev    A matching hash proves the database record has not changed since anchoring.
///         It does NOT prove the original data was true.
contract HoneyChainAnchor {
    struct Anchor {
        bytes32 recordHash;
        uint64 anchoredAt; // block timestamp
        uint16 scheme;     // hashing scheme version (1 = hc-v1)
        address anchoredBy;
    }

    address public owner;
    mapping(address => bool) public isAnchorer;
    mapping(bytes32 => Anchor[]) private _history;

    event RecordAnchored(bytes32 indexed recordKey, bytes32 recordHash, uint16 scheme, uint256 version, address indexed anchoredBy);
    event AnchorerSet(address indexed account, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotAnchorer();
    error ZeroValue();
    error NoAnchor();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        isAnchorer[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AnchorerSet(msg.sender, true);
    }

    /// @notice Append a new hash for a record. Returns the version number (0-based).
    function anchor(bytes32 recordKey, bytes32 recordHash, uint16 scheme) external returns (uint256 version) {
        if (!isAnchorer[msg.sender]) revert NotAnchorer();
        if (recordKey == bytes32(0) || recordHash == bytes32(0) || scheme == 0) revert ZeroValue();
        _history[recordKey].push(Anchor(recordHash, uint64(block.timestamp), scheme, msg.sender));
        version = _history[recordKey].length - 1;
        emit RecordAnchored(recordKey, recordHash, scheme, version, msg.sender);
    }

    /// @notice Most recent anchor for a record. Reverts with NoAnchor if never anchored.
    function latest(bytes32 recordKey) external view returns (Anchor memory) {
        uint256 n = _history[recordKey].length;
        if (n == 0) revert NoAnchor();
        return _history[recordKey][n - 1];
    }

    function anchorAt(bytes32 recordKey, uint256 version) external view returns (Anchor memory) {
        if (version >= _history[recordKey].length) revert NoAnchor();
        return _history[recordKey][version];
    }

    function versionCount(bytes32 recordKey) external view returns (uint256) {
        return _history[recordKey].length;
    }

    function setAnchorer(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroValue();
        isAnchorer[account] = allowed;
        emit AnchorerSet(account, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroValue();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
