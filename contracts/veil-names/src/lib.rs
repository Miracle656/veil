#![no_std]
//! Veil Names — the registry.
//!
//! A name is `jack*useveilapp.xyz`, resolved over SEP-2 federation to whatever
//! address holds it. This contract is the source of truth for who that is.
//!
//! It is a separate deployment that shares nothing with the wallet, factory,
//! multisig or vault contracts. Nothing here calls them and nothing there
//! calls this.
//!
//! ## Names are rented, and that is the whole design problem
//!
//! A name is registered for one to five years and stops resolving the instant
//! it expires. Rental buys back abandoned names, but it creates a hazard
//! ownership could not: a lapsed name taken by somebody else keeps working in
//! every contact list that already has it, and starts paying a stranger.
//!
//! So there are three states, and the middle one exists entirely to contain
//! that:
//!
//! | State      | Resolves | Who may register it            |
//! |------------|----------|--------------------------------|
//! | `Active`   | yes      | nobody                         |
//! | `Recovery` | **no**   | the previous holder only, 90d  |
//! | `Open`     | no       | anyone                         |
//!
//! `Recovery` does double duty: somebody who forgot a 3 USDC renewal gets
//! their name back rather than losing it to whoever was watching the expiry
//! list, and every stale contact fails for a full quarter before a repoint is
//! even possible.
//!
//! ## "Burn at expiry" is lazy, because it has to be
//!
//! Nothing executes on-chain at a timestamp — no contract runs itself when a
//! ledger closes. So the token cannot literally be burned at the expiry
//! second. Instead every read gates on expiry, so from the outside the token
//! stops being owned exactly when the name lapses, and the ledger entry is
//! actually cleared when the name is next registered. Same observable
//! behaviour, no keeper required for correctness.
//!
//! Re-registration mints a **new** token id rather than moving the old one.
//! Reusing the id would make an indexer read a fresh registration as the same
//! collectible changing hands, which it is not.
//!
//! ## Validation lives here, not only in the client
//!
//! The page and the API both check the charset, the length and the reserved
//! list, but neither is a control: anyone can invoke this contract directly.
//! A name resolves to a payment destination, so a homoglyph that reads as
//! somebody else's name is a redirect, and `support` in a stranger's hands is
//! a phishing address this registry would endorse. Those checks are therefore
//! enforced on-chain, and the client copies exist only to fail fast.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
    String, Symbol,
};
use stellar_tokens::non_fungible::{
    burnable::NonFungibleBurnable, Base, NonFungibleToken,
};

/// Seconds in a registration year — a flat 365 days, never a calendar year.
///
/// The contract, the server and the client must all compute one expiry, and
/// "a year from 29 February" has no single answer.
pub const YEAR_SECONDS: u64 = 365 * 24 * 60 * 60;

/// How long after expiry only the previous holder may re-register.
pub const RECOVERY_SECONDS: u64 = 90 * 24 * 60 * 60;

pub const MIN_NAME_LEN: u32 = 3;
pub const MAX_NAME_LEN: u32 = 20;
pub const MIN_TERM_YEARS: u32 = 1;
pub const MAX_TERM_YEARS: u32 = 5;

/// Stroops per USDC. Stellar assets carry seven decimal places.
pub const UNIT: i128 = 10_000_000;

/// Ledgers in roughly 30 days at five seconds a ledger, matching the TTL
/// policy the factory contract already uses.
const TTL_THRESHOLD: u32 = 29 * 17_280;
const TTL_EXTEND_TO: u32 = 30 * 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NameTooShort = 3,
    NameTooLong = 4,
    BadCharset = 5,
    BadSeparator = 6,
    Reserved = 7,
    BadTerm = 8,
    NameTaken = 9,
    /// Expired, but inside the 90-day window where only the previous holder
    /// may take it back.
    InRecovery = 10,
    NameNotFound = 11,
    NotAdmin = 12,
    /// A renewal would push the term past the maximum in one go.
    TermTooLong = 13,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// The SAC address of the asset names are paid in (USDC).
    PayToken,
    /// Where name payments go.
    Treasury,
    /// name -> Record
    Name(String),
    /// name -> () for names nobody may register
    Reserved(String),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Record {
    /// The NFT representing the current registration.
    pub token_id: u32,
    /// Who holds it. After expiry this is the *previous* holder, which is what
    /// the recovery window is checked against.
    pub owner: Address,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NameState {
    Active = 0,
    Recovery = 1,
    Open = 2,
}

#[contract]
pub struct VeilNames;

// ───────────────────────── validation ─────────────────────────

/// Copy a name's bytes out so they can be inspected one at a time.
///
/// Soroban strings cannot be indexed, and `copy_into_slice` traps unless the
/// slice length matches exactly, so the length is checked first and only that
/// many bytes are copied.
fn name_bytes(e: &Env, name: &String) -> ([u8; MAX_NAME_LEN as usize], usize) {
    let len = name.len();
    if len < MIN_NAME_LEN {
        panic_with_error!(e, Error::NameTooShort);
    }
    if len > MAX_NAME_LEN {
        panic_with_error!(e, Error::NameTooLong);
    }
    let mut buf = [0u8; MAX_NAME_LEN as usize];
    name.copy_into_slice(&mut buf[..len as usize]);
    (buf, len as usize)
}

/// Enforce the shape of a name: length, charset and separators.
///
/// The charset is `[a-z0-9_]` and nothing else. Rejecting rather than folding
/// anything outside it is the point — a Cyrillic "а" reads as an "a", and a
/// name that reads as somebody else's is a payment redirect, not a typo.
fn validate_shape(e: &Env, name: &String) {
    let (buf, len) = name_bytes(e, name);
    for i in 0..len {
        let c = buf[i];
        let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_';
        if !ok {
            panic_with_error!(e, Error::BadCharset);
        }
    }
    if buf[0] == b'_' || buf[len - 1] == b'_' {
        panic_with_error!(e, Error::BadSeparator);
    }
    for i in 1..len {
        if buf[i] == b'_' && buf[i - 1] == b'_' {
            panic_with_error!(e, Error::BadSeparator);
        }
    }
}

/// Reject a reserved name, and the same name padded with underscores.
///
/// `s_u_p_p_o_r_t` poses as support just as well in any screen that renders
/// it, so the stripped form is checked too.
fn check_not_reserved(e: &Env, name: &String) {
    if e.storage().persistent().has(&DataKey::Reserved(name.clone())) {
        panic_with_error!(e, Error::Reserved);
    }
    let (buf, len) = name_bytes(e, name);
    let mut stripped = [0u8; MAX_NAME_LEN as usize];
    let mut n = 0usize;
    for i in 0..len {
        if buf[i] != b'_' {
            stripped[n] = buf[i];
            n += 1;
        }
    }
    if n != len && n > 0 {
        let bare = String::from_bytes(e, &stripped[..n]);
        if e.storage().persistent().has(&DataKey::Reserved(bare)) {
            panic_with_error!(e, Error::Reserved);
        }
    }
}

fn validate_term(e: &Env, years: u32) {
    if years < MIN_TERM_YEARS || years > MAX_TERM_YEARS {
        panic_with_error!(e, Error::BadTerm);
    }
}

/// Price per year in USDC stroops, by length band.
///
/// `1-5 => 3, 6-10 => 5, 11+ => 2`. Deliberately not monotonic: the dearest
/// band is the middle one because real first names are six to ten characters
/// and that is where the demand is. It prices demand, not scarcity. Do not
/// "correct" it into a descending curve.
pub fn price_per_year(len: u32) -> i128 {
    if len <= 5 {
        3 * UNIT
    } else if len <= 10 {
        5 * UNIT
    } else {
        2 * UNIT
    }
}

// ───────────────────────── storage helpers ─────────────────────────

fn load(e: &Env, name: &String) -> Option<Record> {
    let key = DataKey::Name(name.clone());
    let rec: Option<Record> = e.storage().persistent().get(&key);
    if rec.is_some() {
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
    rec
}

fn save(e: &Env, name: &String, rec: &Record) {
    let key = DataKey::Name(name.clone());
    e.storage().persistent().set(&key, rec);
    e.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn state_of(rec: &Record, now: u64) -> NameState {
    if now < rec.expires_at {
        NameState::Active
    } else if now < rec.expires_at + RECOVERY_SECONDS {
        NameState::Recovery
    } else {
        NameState::Open
    }
}

fn admin(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(e, Error::NotInitialized))
}

// ───────────────────────── the registry ─────────────────────────

#[contractimpl]
impl VeilNames {
    /// Set the admin, the asset names are paid in, and where payments go.
    ///
    /// `pay_token` is a SAC address — USDC's — and `treasury` the account that
    /// receives it.
    pub fn initialize(e: Env, admin: Address, pay_token: Address, treasury: Address) {
        if e.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(e, Error::AlreadyInitialized);
        }
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::PayToken, &pay_token);
        e.storage().instance().set(&DataKey::Treasury, &treasury);
        Base::set_metadata(
            &e,
            String::from_str(&e, "https://useveilapp.xyz/names/"),
            String::from_str(&e, "Veil Names"),
            String::from_str(&e, "VNAME"),
        );
    }

    /// Mark names nobody may register.
    ///
    /// Admin-held rather than compiled in, because this contract cannot be
    /// upgraded and the list will certainly need adding to — a partner brand,
    /// a product name that does not exist yet. A list baked into the WASM
    /// would be frozen on the day of deployment.
    pub fn reserve(e: Env, name: String) {
        admin(&e).require_auth();
        e.storage()
            .persistent()
            .set(&DataKey::Reserved(name.clone()), &());
        e.storage().persistent().extend_ttl(
            &DataKey::Reserved(name),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );
    }

    /// What a registration would cost, in stroops of the payment asset.
    pub fn quote(e: Env, name: String, years: u32) -> i128 {
        validate_shape(&e, &name);
        validate_term(&e, years);
        price_per_year(name.len()) * i128::from(years)
    }

    /// Where a name points, or `None` if it does not resolve.
    ///
    /// This is what federation answers from. An expired name returns `None`
    /// from the instant it lapses — no grace. A name that still resolves after
    /// its term is a name whose holder believes it is working.
    pub fn resolve(e: Env, name: String) -> Option<Address> {
        let rec = load(&e, &name)?;
        if state_of(&rec, e.ledger().timestamp()) == NameState::Active {
            Some(rec.owner)
        } else {
            None
        }
    }

    /// When a name runs out, whether or not it already has.
    pub fn expires_at(e: Env, name: String) -> Option<u64> {
        load(&e, &name).map(|r| r.expires_at)
    }

    /// Active, in recovery, or open to anyone.
    pub fn state(e: Env, name: String) -> NameState {
        match load(&e, &name) {
            None => NameState::Open,
            Some(rec) => state_of(&rec, e.ledger().timestamp()),
        }
    }

    /// Register a name and take payment for it in one invocation.
    ///
    /// Payment and issuance are deliberately the same call: split across two,
    /// a transfer that lands while the mint fails leaves somebody out of
    /// pocket with nothing to show, which is the failure the offramp already
    /// needs a whole table to track. Here it cannot happen — either both
    /// happen or the transaction reverts.
    ///
    /// Returns the new token id.
    pub fn register(e: Env, buyer: Address, name: String, years: u32) -> u32 {
        buyer.require_auth();
        validate_shape(&e, &name);
        check_not_reserved(&e, &name);
        validate_term(&e, years);

        let now = e.ledger().timestamp();
        if let Some(prev) = load(&e, &name) {
            match state_of(&prev, now) {
                NameState::Active => panic_with_error!(&e, Error::NameTaken),
                // Only the previous holder, and only for 90 days.
                NameState::Recovery if prev.owner != buyer => {
                    panic_with_error!(&e, Error::InRecovery)
                }
                _ => {
                    // The lapsed registration's token stops existing here. It
                    // has not been owned since `expires_at` as far as every
                    // read is concerned; this is where the ledger catches up.
                    Base::burn(&e, &prev.owner, prev.token_id);
                }
            }
        }

        let amount = price_per_year(name.len()) * i128::from(years);
        let pay_token: Address = e
            .storage()
            .instance()
            .get(&DataKey::PayToken)
            .unwrap_or_else(|| panic_with_error!(&e, Error::NotInitialized));
        let treasury: Address = e
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .unwrap_or_else(|| panic_with_error!(&e, Error::NotInitialized));
        token::Client::new(&e, &pay_token).transfer(&buyer, &treasury, &amount);

        // A fresh id, never the lapsed one: reusing it would make an indexer
        // read a new registration as the same collectible changing hands.
        let token_id = Base::sequential_mint(&e, &buyer);
        save(
            &e,
            &name,
            &Record {
                token_id,
                owner: buyer.clone(),
                expires_at: now + u64::from(years) * YEAR_SECONDS,
            },
        );
        e.events().publish(
            (Symbol::new(&e, "register"), buyer, name),
            (token_id, years),
        );
        token_id
    }

    /// Extend a name's term. Anyone may pay.
    ///
    /// There is no access check here and that is deliberate. Renewal only ever
    /// extends a name for its current holder — it cannot move it, re-point it
    /// or take it — so the worst a stranger can do is pay somebody's bill.
    /// Refusing that would mean a name lapsing because its holder lost their
    /// phone in the wrong week while a friend would gladly have covered it.
    pub fn renew(e: Env, payer: Address, name: String, years: u32) {
        payer.require_auth();
        validate_term(&e, years);

        let mut rec = load(&e, &name).unwrap_or_else(|| panic_with_error!(&e, Error::NameNotFound));
        let now = e.ledger().timestamp();
        if state_of(&rec, now) == NameState::Open {
            // Past recovery the name is simply gone; renewing it would hand it
            // back to a holder who no longer has any claim on it.
            panic_with_error!(&e, Error::NameNotFound);
        }

        // Extend from the later of now and the current expiry, so renewing
        // early never costs the holder time they already paid for, and
        // renewing in recovery does not sell back time already spent.
        let base = if rec.expires_at > now { rec.expires_at } else { now };
        let new_expiry = base + u64::from(years) * YEAR_SECONDS;
        if new_expiry > now + u64::from(MAX_TERM_YEARS) * YEAR_SECONDS {
            panic_with_error!(&e, Error::TermTooLong);
        }

        let amount = price_per_year(name.len()) * i128::from(years);
        let pay_token: Address = e
            .storage()
            .instance()
            .get(&DataKey::PayToken)
            .unwrap_or_else(|| panic_with_error!(&e, Error::NotInitialized));
        let treasury: Address = e
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .unwrap_or_else(|| panic_with_error!(&e, Error::NotInitialized));
        token::Client::new(&e, &pay_token).transfer(&payer, &treasury, &amount);

        rec.expires_at = new_expiry;
        save(&e, &name, &rec);
        e.events()
            .publish((Symbol::new(&e, "renew"), name), (new_expiry, years));
    }

    /// Point a name at a different address without moving the token.
    ///
    /// Only the holder, and only while the name is active.
    pub fn set_target(e: Env, name: String, target: Address) {
        let mut rec = load(&e, &name).unwrap_or_else(|| panic_with_error!(&e, Error::NameNotFound));
        if state_of(&rec, e.ledger().timestamp()) != NameState::Active {
            panic_with_error!(&e, Error::NameNotFound);
        }
        rec.owner.require_auth();
        rec.owner = target;
        save(&e, &name, &rec);
    }
}

// ───────────────────────── SEP-50 surface ─────────────────────────

#[contractimpl]
impl NonFungibleToken for VeilNames {
    type ContractType = Base;

    fn balance(e: &Env, account: Address) -> u32 {
        Base::balance(e, &account)
    }

    fn owner_of(e: &Env, token_id: u32) -> Address {
        Base::owner_of(e, token_id)
    }

    fn transfer(e: &Env, from: Address, to: Address, token_id: u32) {
        Base::transfer(e, &from, &to, token_id);
    }

    fn transfer_from(e: &Env, spender: Address, from: Address, to: Address, token_id: u32) {
        Base::transfer_from(e, &spender, &from, &to, token_id);
    }

    fn approve(
        e: &Env,
        approver: Address,
        approved: Address,
        token_id: u32,
        live_until_ledger: u32,
    ) {
        Base::approve(e, &approver, &approved, token_id, live_until_ledger);
    }

    fn approve_for_all(e: &Env, owner: Address, operator: Address, live_until_ledger: u32) {
        Base::approve_for_all(e, &owner, &operator, live_until_ledger);
    }

    fn get_approved(e: &Env, token_id: u32) -> Option<Address> {
        Base::get_approved(e, token_id)
    }

    fn is_approved_for_all(e: &Env, owner: Address, operator: Address) -> bool {
        Base::is_approved_for_all(e, &owner, &operator)
    }

    fn name(e: &Env) -> String {
        Base::name(e)
    }

    fn symbol(e: &Env) -> String {
        Base::symbol(e)
    }

    fn token_uri(e: &Env, token_id: u32) -> String {
        Base::token_uri(e, token_id)
    }
}

#[contractimpl]
impl NonFungibleBurnable for VeilNames {
    fn burn(e: &Env, from: Address, token_id: u32) {
        Base::burn(e, &from, token_id);
    }

    fn burn_from(e: &Env, spender: Address, from: Address, token_id: u32) {
        Base::burn_from(e, &spender, &from, token_id);
    }
}

#[cfg(test)]
mod test;
