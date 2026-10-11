// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockNFT — minimal ERC721 with fully on-chain SVG art, for demos.
/// @notice Demo-grade and unaudited. Do not use with real value.
contract MockNFT {
    string public name;
    string public symbol;
    uint8 public constant decimals = 0;
    uint256 public nextTokenId = 1;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _approvals;
    mapping(address => mapping(address => bool)) private _operators;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "zero owner");
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        require(o != address(0), "nonexistent");
        return o;
    }

    function mint(address to) external returns (uint256 tokenId) {
        require(to != address(0), "zero to");
        tokenId = nextTokenId++;
        _owners[tokenId] = to;
        _balances[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    /// @notice Mint `count` sequential tokens to `to`. Capped per call for gas safety.
    function mintBatch(address to, uint256 count) external returns (uint256 firstTokenId) {
        require(to != address(0), "zero to");
        require(count > 0 && count <= 100, "bad count");
        firstTokenId = nextTokenId;
        for (uint256 i = 0; i < count; i++) {
            uint256 tokenId = nextTokenId++;
            _owners[tokenId] = to;
            emit Transfer(address(0), to, tokenId);
        }
        _balances[to] += count;
    }

    function approve(address spender, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        require(msg.sender == owner || _operators[owner][msg.sender], "not authorized");
        _approvals[tokenId] = spender;
        emit Approval(owner, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(_owners[tokenId] != address(0), "nonexistent");
        return _approvals[tokenId];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        require(owner == from, "wrong from");
        require(to != address(0), "zero to");
        require(
            msg.sender == owner || _approvals[tokenId] == msg.sender || _operators[owner][msg.sender],
            "not authorized"
        );
        delete _approvals[tokenId];
        _owners[tokenId] = to;
        _balances[from] -= 1;
        _balances[to] += 1;
        emit Transfer(from, to, tokenId);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        address owner = ownerOf(tokenId);
        string memory svg = string(
            abi.encodePacked(
                "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'>",
                "<rect width='400' height='400' fill='hsl(",
                _toString((tokenId * 47) % 360),
                ",70%,45%)'/>",
                "<circle cx='200' cy='170' r='90' fill='hsl(",
                _toString((tokenId * 47 + 180) % 360),
                ",80%,65%)'/>",
                "<rect x='120' y='280' width='160' height='40' rx='20' fill='#0B0B12'/>",
                "<text x='200' y='308' font-size='24' text-anchor='middle' fill='#ffffff'>#",
                _toString(tokenId),
                "</text></svg>"
            )
        );
        string memory json = string(
            abi.encodePacked(
                '{"name":"MDP #',
                _toString(tokenId),
                '","description":"MonadMCP demo NFT on Monad testnet.","image":"data:image/svg+xml;base64,',
                _base64(bytes(svg)),
                '"}'
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", _base64(bytes(json))));
    }

    function _toString(uint256 x) internal pure returns (string memory) {
        if (x == 0) return "0";
        uint256 len;
        uint256 y = x;
        while (y > 0) {
            len++;
            y /= 10;
        }
        bytes memory b = new bytes(len);
        while (x > 0) {
            b[--len] = bytes1(uint8(48 + (x % 10)));
            x /= 10;
        }
        return string(b);
    }

    string internal constant _ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function _base64(bytes memory data) internal pure returns (string memory) {
        uint256 n = data.length;
        if (n == 0) return "";
        uint256 outLen = 4 * ((n + 2) / 3);
        bytes memory out = new bytes(outLen);
        bytes memory alpha = bytes(_ALPHABET);
        uint256 i;
        uint256 j;
        for (i = 0; i < n; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < n ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < n ? uint8(data[i + 2]) : 0;
            uint256 triple = (a << 16) | (b << 8) | c;
            out[j++] = alpha[(triple >> 18) & 0x3F];
            out[j++] = alpha[(triple >> 12) & 0x3F];
            out[j++] = i + 1 < n ? alpha[(triple >> 6) & 0x3F] : bytes1("=");
            out[j++] = i + 2 < n ? alpha[triple & 0x3F] : bytes1("=");
        }
        return string(out);
    }

    // Silence unused warning in explorers that check ERC721 interface extras.
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd || id == 0x5b5e139f || id == 0x01ffc9a7;
    }

    // Referenced so compilers/explorers see standard metadata hooks.
    function _ownerHook(address o) internal pure returns (address) {
        return o;
    }
}
