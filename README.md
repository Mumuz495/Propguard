# 🛡️ PropGuard

> Always in the Market. Never Blow Any Account.

PropGuard is a multi-prop account risk control system for traders managing multiple evaluation, funded, and personal accounts.

Instead of treating each account separately, PropGuard helps you manage all accounts as one risk portfolio.

Its core goal is simple:

**keep every account alive, control total risk, and turn prop trading into positive cashflow.**

---

## Why PropGuard?

Most prop traders do not fail because of strategy.

They fail because of:

- overlapping risk across multiple accounts
- daily drawdown mismanagement
- poor cost tracking
- revenge trading and FOMO
- lack of account-level discipline
- no system for long-term survival

PropGuard is designed to solve that.

---

## Core Features

### 1. Multi-Account Management
- Track evaluation, funded, and personal accounts
- Assign account roles:
  - Primary
  - Conservative
  - Aggressive
  - Backup
  - Recovery
- View all accounts from one dashboard

### 2. Global Risk Control
- Monitor total portfolio risk exposure
- Break down risk by account
- Set max drawdown, daily loss, and lot limits
- Prevent hidden risk stacking across accounts

### 3. Cost & Cashflow Tracking
- Track signup fees
- Track activation fees
- Track reset fees
- Track payouts and withdrawals
- Calculate real net profit after all prop costs

### 4. Trade Journal & Statistics
- Record trades manually
- Review daily P&L
- Analyze win rate, average win/loss, profit factor, expectancy
- Evaluate performance by session and time

### 5. Compliance Review
- Detect over-risk trades
- Flag oversized positions
- Mark suspicious or rule-breaking behavior
- Identify FOMO / revenge trades
- Help simulate prop-firm compliance discipline

### 6. Next Trade Engine
- Decide whether the next trade is:
  - allowed
  - caution
  - blocked
- Based on current drawdown, streaks, and account condition

### 7. Account State Machine
Each account can automatically move between:
- Normal
- Restricted
- Frozen
- Recovering

This turns discipline into a system instead of relying on emotion.

### 8. Journal & Coaching Review
- Daily journal tracking
- Auto review suggestions
- Structured post-trade reflection
- Clear feedback on execution quality

### 9. Risk Dashboard
- Real-time account health monitoring
- Portfolio-level warning system
- Survival-first operating logic

---

## Philosophy

PropGuard is built on three principles:

### Survival first
If the account dies, the strategy no longer matters.

### Portfolio thinking
Multiple prop accounts are not isolated.
They form one combined risk structure.

### Real cashflow matters
Gross P&L is meaningless if fees, resets, and failed accounts destroy profitability.

---

## Tech Stack

- HTML
- CSS
- JavaScript
- Firebase Auth
- Firestore

---

## Project Structure

```bash
PropGuard/
├── index.html
├── README.md
├── LICENSE
└── assets/
