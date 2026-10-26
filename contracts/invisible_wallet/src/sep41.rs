//! SEP-41 token interface — the argument layouts of the calls that move tokens.
//!
//! `transfer`, `transfer_from`, `approve` and `burn` all move a token, but they
//! do not agree on where the amount sits: `transfer` puts it at index 2,
//! `transfer_from` at index 3, `approve` at index 2, `burn` at index 1. A
//! policy that reads a fixed argument index is therefore not reading an
//! amount — it is reading whatever happens to be at that position, which is an
//! `Address` for `transfer_from` and out of bounds for `burn`.
//!
//! Two callers depend on this table, and they have to agree:
//!
//!   * `session_key` — the session-key ACL that bounds a delegated key.
//!   * `policies::spend_limit` — the per-key, per-token 24-hour cap.
//!
//! One table, so a call the session-key budget can price is a call the
//! spend-limit budget can price too. Two copies of this table would drift,
//! and a call priced by one budget but not the other is a hole in the other.

use soroban_sdk::{Address, Env, Symbol, TryFromVal, Val, Vec};

/// What a token call does, as read from its arguments.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallEffect {
    /// The amount of the token's base units the call moves.
    pub amount: i128,
    /// The recipient of the move, where the interface names one.
    /// `None` for selectors with no recipient (e.g. `burn`).
    pub payee: Option<Address>,
}

/// The call is not a token movement this module can price.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NotATokenCall;

/// Read the amount (and recipient) out of a SEP-41 token call.
///
/// | selector        | args                                   | amount | payee   |
/// |-----------------|----------------------------------------|--------|---------|
/// | `transfer`      | `(from, to, amount)`                   | 2      | `to`    |
/// | `transfer_from` | `(spender, from, to, amount)`          | 3      | `to`    |
/// | `approve`       | `(from, spender, amount, expiration)`  | 2      | spender |
/// | `burn`          | `(from, amount)`                       | 1      | none    |
///
/// Returns [`NotATokenCall`] for a selector outside the token interface, for
/// the wrong number of arguments, and for an argument of the wrong type.
/// Nothing is guessed: an amount that cannot be read is an amount that cannot
/// be budgeted, and the caller decides what that means.
pub fn describe(
    env: &Env,
    selector: &Symbol,
    args: &Vec<Val>,
) -> Result<CallEffect, NotATokenCall> {
    let (len, amount_idx, payee_idx): (u32, u32, Option<u32>) =
        if *selector == Symbol::new(env, "transfer") {
            (3, 2, Some(1))
        } else if *selector == Symbol::new(env, "transfer_from") {
            (4, 3, Some(2))
        } else if *selector == Symbol::new(env, "approve") {
            (4, 2, Some(1))
        } else if *selector == Symbol::new(env, "burn") {
            (2, 1, None)
        } else {
            return Err(NotATokenCall);
        };

    if args.len() != len {
        return Err(NotATokenCall);
    }

    let amount =
        i128::try_from_val(env, &args.get(amount_idx).unwrap()).map_err(|_| NotATokenCall)?;
    let payee = match payee_idx {
        Some(i) => {
            Some(Address::try_from_val(env, &args.get(i).unwrap()).map_err(|_| NotATokenCall)?)
        }
        None => None,
    };
    Ok(CallEffect { amount, payee })
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{symbol_short, testutils::Address as _, IntoVal};

    fn args(env: &Env, vals: &[soroban_sdk::Val]) -> Vec<Val> {
        Vec::from_slice(env, vals)
    }

    #[test]
    fn transfer_reads_amount_and_payee() {
        let env = Env::default();
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let a = args(
            &env,
            &[
                from.into_val(&env),
                to.clone().into_val(&env),
                42i128.into_val(&env),
            ],
        );
        let e = describe(&env, &symbol_short!("transfer"), &a).unwrap();
        assert_eq!(
            e,
            CallEffect {
                amount: 42,
                payee: Some(to)
            }
        );
    }

    #[test]
    fn transfer_from_reads_the_fourth_argument() {
        let env = Env::default();
        let spender = Address::generate(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let a = args(
            &env,
            &[
                spender.into_val(&env),
                from.into_val(&env),
                to.clone().into_val(&env),
                7i128.into_val(&env),
            ],
        );
        let e = describe(&env, &Symbol::new(&env, "transfer_from"), &a).unwrap();
        assert_eq!(
            e,
            CallEffect {
                amount: 7,
                payee: Some(to)
            }
        );
    }

    #[test]
    fn approve_and_burn_read_their_own_layout() {
        let env = Env::default();
        let from = Address::generate(&env);
        let spender = Address::generate(&env);

        let approve_args = args(
            &env,
            &[
                from.clone().into_val(&env),
                spender.clone().into_val(&env),
                9i128.into_val(&env),
                100u32.into_val(&env),
            ],
        );
        let e = describe(&env, &symbol_short!("approve"), &approve_args).unwrap();
        assert_eq!(
            e,
            CallEffect {
                amount: 9,
                payee: Some(spender)
            }
        );

        let burn_args = args(&env, &[from.into_val(&env), 5i128.into_val(&env)]);
        let e = describe(&env, &symbol_short!("burn"), &burn_args).unwrap();
        assert_eq!(
            e,
            CallEffect {
                amount: 5,
                payee: None
            }
        );
    }

    #[test]
    fn unknown_selector_and_malformed_args_are_refused() {
        let env = Env::default();
        let from = Address::generate(&env);
        let to = Address::generate(&env);

        let two = args(
            &env,
            &[
                from.clone().into_val(&env),
                to.clone().into_val(&env),
                1i128.into_val(&env),
            ],
        );

        // Not part of the token interface at all.
        assert_eq!(
            describe(&env, &symbol_short!("mint"), &two),
            Err(NotATokenCall)
        );

        // Right selector, wrong argument count.
        let short = args(
            &env,
            &[from.clone().into_val(&env), to.clone().into_val(&env)],
        );
        assert_eq!(
            describe(&env, &symbol_short!("transfer"), &short),
            Err(NotATokenCall)
        );

        // Right selector, right count, wrong type where the amount belongs.
        let bad = args(
            &env,
            &[
                from.into_val(&env),
                to.into_val(&env),
                symbol_short!("x").into_val(&env),
            ],
        );
        assert_eq!(
            describe(&env, &symbol_short!("transfer"), &bad),
            Err(NotATokenCall)
        );
    }
}
