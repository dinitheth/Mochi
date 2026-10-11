// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title NftLendingPool — NFT-collateralized MON lending (fixed 50% LTV).
/// @notice Lenders earn borrower interest pro-rata via a growing share price.
///         Floors are admin-set per whitelisted collection (floor > 0).
///         Demo-grade and unaudited. Do not use with real value.
contract NftLendingPool {
    struct Loan {
        address borrower;
        address nft;
        uint256 tokenId;
        uint256 principal;
        uint64 startTime;
        bool repaid;
    }

    address public immutable owner;
    /// @notice Borrow interest in basis points per year (1000 = 10% APR).
    uint256 public borrowRateBps = 1000;
    /// @notice Max loan-to-value in basis points (5000 = 50%).
    uint256 public constant MAX_LTV_BPS = 5000;
    uint256 private constant BPS = 10000;
    uint256 private constant YEAR = 365 days;

    uint256 public totalShares;
    uint256 public totalOutstanding;
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public floorOf; // nft => floor in wei (0 = not whitelisted)

    uint256 public loanCount;
    mapping(uint256 => Loan) public loans;

    event Deposit(address indexed lender, uint256 amount, uint256 shares);
    event Withdraw(address indexed lender, uint256 shares, uint256 amount);
    event Borrow(uint256 indexed loanId, address indexed borrower, address indexed nft, uint256 tokenId, uint256 amount);
    event Repay(uint256 indexed loanId, uint256 paid, bool closed);
    event FloorSet(address indexed nft, uint256 price);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @notice Pool assets = idle balance + outstanding principal (interest excluded until repaid).
    function poolAssets() public view returns (uint256) {
        return address(this).balance + totalOutstanding;
    }

    function sharePrice() public view returns (uint256) {
        if (totalShares == 0) return 1 ether;
        return (poolAssets() * 1 ether) / totalShares;
    }

    function utilizationBps() public view returns (uint256) {
        uint256 assets = poolAssets();
        if (assets == 0) return 0;
        return (totalOutstanding * BPS) / assets;
    }

    function setFloor(address nft, uint256 priceWei) external onlyOwner {
        floorOf[nft] = priceWei;
        emit FloorSet(nft, priceWei);
    }

    function setBorrowRateBps(uint256 bps) external onlyOwner {
        require(bps <= 10000, "rate too high");
        borrowRateBps = bps;
    }

    function deposit() external payable returns (uint256 shares) {
        require(msg.value > 0, "zero deposit");
        uint256 assetsBefore = address(this).balance - msg.value;
        if (totalShares == 0) {
            shares = msg.value;
        } else {
            require(assetsBefore > 0, "empty pool");
            shares = (msg.value * totalShares) / assetsBefore;
        }
        require(shares > 0, "dust");
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposit(msg.sender, msg.value, shares);
    }

    function withdraw(uint256 shares) external {
        require(shares > 0 && sharesOf[msg.sender] >= shares, "bad shares");
        uint256 assets = (shares * poolAssets()) / totalShares;
        require(assets <= address(this).balance, "illiquid");
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        (bool paid, ) = msg.sender.call{ value: assets }("");
        require(paid, "payout failed");
        emit Withdraw(msg.sender, shares, assets);
    }

    /// @notice Borrow MON against a whitelisted NFT (caller must approve this pool first).
    function borrow(address nft, uint256 tokenId, uint256 amount) external returns (uint256 loanId) {
        uint256 floor = floorOf[nft];
        require(floor > 0, "collection not whitelisted");
        require(amount > 0, "zero loan");
        require(amount * BPS <= floor * MAX_LTV_BPS, "exceeds 50% LTV");
        require(amount <= address(this).balance, "pool illiquid");
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
        loanId = ++loanCount;
        loans[loanId] = Loan({
            borrower: msg.sender,
            nft: nft,
            tokenId: tokenId,
            principal: amount,
            startTime: uint64(block.timestamp),
            repaid: false
        });
        totalOutstanding += amount;
        (bool paid, ) = msg.sender.call{ value: amount }("");
        require(paid, "loan payout failed");
        emit Borrow(loanId, msg.sender, nft, tokenId, amount);
    }

    function debtOf(uint256 loanId) public view returns (uint256) {
        Loan memory l = loans[loanId];
        require(l.borrower != address(0), "no loan");
        if (l.repaid) return 0;
        uint256 dt = block.timestamp - l.startTime;
        return l.principal + (l.principal * borrowRateBps * dt) / (BPS * YEAR);
    }

    /// @notice Repay part or all. Full repayment (plus accrued interest) releases the NFT.
    ///         Zero-principal (dust) loans release with no payment beyond gas.
    function repay(uint256 loanId) external payable {
        Loan storage l = loans[loanId];
        require(l.borrower != address(0), "no loan");
        require(!l.repaid, "repaid");
        require(msg.sender == l.borrower, "not borrower");
        if (l.principal == 0) {
            l.repaid = true;
            IERC721(l.nft).transferFrom(address(this), l.borrower, l.tokenId);
            if (msg.value > 0) {
                (bool refunded, ) = msg.sender.call{ value: msg.value }("");
                require(refunded, "refund failed");
            }
            emit Repay(loanId, 0, true);
            return;
        }
        require(msg.value > 0, "zero repay");
        uint256 owed = this.debtOf(loanId);
        if (msg.value >= owed) {
            totalOutstanding -= l.principal;
            l.principal = 0;
            l.repaid = true;
            IERC721(l.nft).transferFrom(address(this), l.borrower, l.tokenId);
            if (msg.value > owed) {
                (bool refunded, ) = msg.sender.call{ value: msg.value - owed }("");
                require(refunded, "refund failed");
            }
            emit Repay(loanId, owed, true);
        } else {
            // Interest accrues on the remainder; payment chips principal first (demo simplification).
            uint256 payPrincipal = msg.value <= l.principal ? msg.value : l.principal;
            l.principal -= payPrincipal;
            totalOutstanding -= payPrincipal;
            if (l.principal == 0) {
                l.repaid = true;
                IERC721(l.nft).transferFrom(address(this), l.borrower, l.tokenId);
                emit Repay(loanId, msg.value, true);
                return;
            }
            emit Repay(loanId, msg.value, false);
        }
    }

    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return loans[loanId];
    }
}
