import React, { useReducer, useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { createBrowserHistory } from 'history'
import { ethers } from 'ethers'
import ReactGA from 'react-ga'
import styled from 'styled-components'

import { Button } from '../../theme'
import CurrencyInputPanel from '../../components/CurrencyInputPanel'
import OversizedPanel from '../../components/OversizedPanel'
import ContextualInfo from '../../components/ContextualInfo'
import { ReactComponent as Plus } from '../../assets/images/plus-blue.svg'
import WarningCard from '../../components/WarningCard'

import { useWeb3React, useExchangeContract } from '../../hooks'
import { brokenTokens } from '../../constants'
import { amountFormatter, calculateGasMargin } from '../../utils'
import { useTransactionAdder } from '../../contexts/Transactions'
import { useTokenDetails, INITIAL_TOKENS_CONTEXT } from '../../contexts/Tokens'
import { useAddressBalance, useExchangeReserves } from '../../contexts/Balances'
import { useAddressAllowance } from '../../contexts/Allowances'

const { bigNumberify } = ethers.utils

const INPUT = 0
const OUTPUT = 1

// denominated in bips
const ALLOWED_SLIPPAGE = bigNumberify(200)

// denominated in seconds
const DEADLINE_FROM_NOW = 60 * 15

// denominated in bips
// const GAS_MARGIN = ethers.utils.bigNumberify(1000)

const BlueSpan = styled.span`
  color: ${({ theme }) => theme.royalBlue};
`

const NewExchangeWarning = styled.div`
  margin-top: 1rem;
  padding: 1rem;

  border: 1px solid rgba($pizazz-orange, 0.4);
  background-color: rgba($pizazz-orange, 0.1);
  border-radius: 1rem;
`

const NewExchangeWarningText = styled.div`
  font-size: 0.8rem;
  line-height: 1rem;
  text-align: center;

  :first-child {
    padding-bottom: 0.3rem;
    font-weight: 500;
  }
`

const LastSummaryText = styled.div`
  margin-top: 1rem;
`

const DownArrowBackground = styled.div`
  ${({ theme }) => theme.flexRowNoWrap}
  justify-content: center;
  align-items: center;
`
const SummaryPanel = styled.div`
  ${({ theme }) => theme.flexColumnNoWrap}
  padding: 1rem 0;
`

const ExchangeRateWrapper = styled.div`
  ${({ theme }) => theme.flexRowNoWrap};
  align-items: center;
  color: ${({ theme }) => theme.doveGray};
  font-size: 0.75rem;
  padding: 0.25rem 1rem 0;
`

const ExchangeRate = styled.span`
  flex: 1 1 auto;
  width: 0;
  color: ${({ theme }) => theme.doveGray};
`

const Flex = styled.div`
  display: flex;
  justify-content: center;
  padding: 2rem;

  button {
    max-width: 20rem;
  }
`

const WrappedPlus = ({ isError, highSlippageWarning, ...rest }) => <Plus {...rest} />
const ColoredWrappedPlus = styled(WrappedPlus)`
  width: 0.625rem;
  height: 0.625rem;
  position: relative;
  padding: 0.875rem;
  path {
    stroke: ${({ active, theme }) => (active ? theme.royalBlue : theme.chaliceGray)};
  }
`

function calculateSlippageBounds(value) {
  if (value) {
    const offset = value.mul(ALLOWED_SLIPPAGE).div(ethers.utils.bigNumberify(10000))
    const minimum = value.sub(offset)
    const maximum = value.add(offset)
    return {
      minimum: minimum.lt(ethers.constants.Zero) ? ethers.constants.Zero : minimum,
      maximum: maximum.gt(ethers.constants.MaxUint256) ? ethers.constants.MaxUint256 : maximum
    }
  } else {
    return {}
  }
}

function calculateMaxOutputVal(value) {
  if (value) {
    return value.mul(ethers.utils.bigNumberify(10000)).div(ALLOWED_SLIPPAGE.add(ethers.utils.bigNumberify(10000)))
  }
}

function initialAddLiquidityState(state) {
  return {
    inputValue: state.ethAmountURL ? state.ethAmountURL : '',
    outputValue: state.tokenAmountURL && !state.ethAmountURL ? state.tokenAmountURL : '',
    lastEditedField: state.tokenAmountURL && state.ethAmountURL === '' ? OUTPUT : INPUT,
    outputCurrency: state.tokenURL ? state.tokenURL : ''
  }
}

function addLiquidityStateReducer(state, action) {
  switch (action.type) {
    case 'SELECT_CURRENCY': {
      return {
        ...state,
        outputCurrency: action.payload
      }
    }
    case 'UPDATE_VALUE': {
      const { inputValue, outputValue } = state
      const { field, value } = action.payload
      const newState = {
        ...state,
        inputValue: field === INPUT ? value : inputValue,
        outputValue: field === OUTPUT ? value : outputValue,
        lastEditedField: field
      }

      console.log("UPDATE_VALUE", { state, action, newState  })
      return newState
    }
    case 'UPDATE_DEPENDENT_VALUE': {
      const { inputValue, outputValue } = state
      const { field, value } = action.payload
      const newState = {
        ...state,
        inputValue: field === INPUT ? value : inputValue,
        outputValue: field === OUTPUT ? value : outputValue
      }
      console.log('UPDATE_DEPENDENT_VALUE', { state, action, newState  })
      return newState
    }
    default: {
      return initialAddLiquidityState()
    }
  }
}

function getExchangeRate(inputValue, inputDecimals, outputValue, outputDecimals, invert = false) {
  try {
    if (
      inputValue &&
      (inputDecimals || inputDecimals === 0) &&
      outputValue &&
      (outputDecimals || outputDecimals === 0)
    ) {
      const factor = ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(6))

      if (invert) {
        return inputValue
          .mul(factor)
          .mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(outputDecimals)))
          .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(inputDecimals)))
          .div(outputValue)
      } else {
        return outputValue
          .mul(factor)
          .mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(inputDecimals)))
          .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(outputDecimals)))
          .div(inputValue)
      }
    }
  } catch {}
}

function getMarketRate(reserveETH, reserveToken, decimals, invert = false) {
  return getExchangeRate(reserveETH, 6, reserveToken, decimals, invert)
}

export default function AddLiquidity({ params }) {
  const { t } = useTranslation()
  const { library, account, active, chainId } = useWeb3React()

  const urlAddedTokens = {}
  if (params.token) {
    urlAddedTokens[params.token] = true
  }

  // clear url of query
  useEffect(() => {
    const history = createBrowserHistory()
    history.push(window.location.pathname + '')
  }, [])

  const [addLiquidityState, dispatchAddLiquidityState] = useReducer(
    addLiquidityStateReducer,
    { ethAmountURL: params.ethAmount, tokenAmountURL: params.tokenAmount, tokenURL: params.token },
    initialAddLiquidityState
  )
  const { inputValue, outputValue, lastEditedField, outputCurrency } = addLiquidityState

  const inputCurrency = 'TRX'

  const [inputValueParsed, setInputValueParsed] = useState()
  const [outputValueParsed, setOutputValueParsed] = useState()
  const [inputError, setInputError] = useState()
  const [outputError, setOutputError] = useState()
  const [zeroDecimalError, setZeroDecimalError] = useState()

  const [brokenTokenWarning, setBrokenTokenWarning] = useState()

  const { symbol, decimals, exchangeAddress } = useTokenDetails(outputCurrency)
  const exchangeContract = useExchangeContract(exchangeAddress)

  const [totalPoolTokens, setTotalPoolTokens] = useState()
  const fetchPoolTokens = useCallback(async () => {
    if (exchangeContract) {
      // console.log({ exchangeContract })
      try {
        //console.log({ exchangeContract })
        const totalSupply = await exchangeContract.totalSupply().call()
        //console.log({ totalSupply })
        setTotalPoolTokens(totalSupply)
      } catch (err) {
        console.error('exchangeContract.totalSupply().call() failed')
        console.error(err)
      }
    }
  }, [exchangeContract])
  useEffect(() => {
    fetchPoolTokens()
    library.on('block', fetchPoolTokens)

    return () => {
      library.removeListener('block', fetchPoolTokens)
    }
  }, [fetchPoolTokens, library])

  const poolTokenBalance = useAddressBalance(account, exchangeAddress)
  const exchangeETHBalance = useAddressBalance(exchangeAddress, 'TRX')
  const exchangeTokenBalance = useAddressBalance(exchangeAddress, outputCurrency)

  const { reserveETH, reserveToken } = useExchangeReserves(outputCurrency)
  /*
  if (reserveETH) {
    console.log({ reserveETH: reserveETH.toString(), reserveToken: reserveToken.toString() })
  } */
  const isNewExchange = !!(reserveETH && reserveToken && reserveETH.isZero() && reserveToken.isZero())

  // 6 decimals
  const poolTokenPercentage =
    poolTokenBalance && totalPoolTokens && isNewExchange === false && !totalPoolTokens.isZero()
      ? poolTokenBalance.mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(6))).div(totalPoolTokens)
      : 0
 
 
  const ethShare =
    exchangeETHBalance && poolTokenPercentage
      ? exchangeETHBalance.mul(poolTokenPercentage).div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(6)))
      : undefined
  const tokenShare =
    exchangeTokenBalance && poolTokenPercentage
      ? exchangeTokenBalance
          .mul(poolTokenPercentage)
          .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(6)))
      : undefined

  const liquidityMinted = isNewExchange
    ? inputValueParsed
    : totalPoolTokens && inputValueParsed && exchangeETHBalance && !exchangeETHBalance.isZero()
    ? totalPoolTokens.mul(inputValueParsed).div(exchangeETHBalance)
    : undefined

  // user balances
  const inputBalance = useAddressBalance(account, inputCurrency)
  const outputBalance = useAddressBalance(account, outputCurrency)

  const ethPerLiquidityToken =
    exchangeETHBalance && totalPoolTokens && isNewExchange === false && !totalPoolTokens.isZero()
      ? exchangeETHBalance.mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(6))).div(totalPoolTokens)
      : undefined
  const tokenPerLiquidityToken =
    exchangeTokenBalance && totalPoolTokens && isNewExchange === false && !totalPoolTokens.isZero()
      ? exchangeTokenBalance.mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(6))).div(totalPoolTokens)
      : undefined

  const outputValueMax = outputValueParsed && calculateSlippageBounds(outputValueParsed).maximum
  const liquidityTokensMin = liquidityMinted && calculateSlippageBounds(liquidityMinted).minimum

  const marketRate = useMemo(() => {
    return getMarketRate(reserveETH, reserveToken, decimals)
  }, [reserveETH, reserveToken, decimals])
  const marketRateInverted = useMemo(() => {
    return getMarketRate(reserveETH, reserveToken, decimals, true)
  }, [reserveETH, reserveToken, decimals])

  function renderTransactionDetails() {
    const b = text => <BlueSpan>{text}</BlueSpan>

    if (isNewExchange) {
      return (
        <div>
          <div>
            {t('youAreAdding')} {b(`${inputValue} TRX`)} {t('and')} {b(`${outputValue} ${symbol}`)} {t('intoPool')}
          </div>
          <LastSummaryText>
            {t('youAreSettingExRate')}{' '}
            {b(
              `1 TRX = ${amountFormatter(
                getMarketRate(inputValueParsed, outputValueParsed, decimals),
                6,
                4,
                false
              )} ${symbol}`
            )}
            .
          </LastSummaryText>
          <LastSummaryText>
            {t('youWillMint')} {b(`${inputValue}`)} {t('liquidityTokens')}
          </LastSummaryText>
          <LastSummaryText>{t('totalSupplyIs0')}</LastSummaryText>
        </div>
      )
    } else {
      return (
        <>
          <div>
            {t('youAreAdding')} {b(`${amountFormatter(inputValueParsed, 6, 4)} TRX`)} {t('and')} {'at most'}{' '}
            {b(`${amountFormatter(outputValueMax, decimals, Math.min(decimals, 4))} ${symbol}`)} {t('intoPool')}
          </div>
          <LastSummaryText>
            {t('youWillMint')} {b(amountFormatter(liquidityMinted, 6, 4))} {t('liquidityTokens')}
          </LastSummaryText>
          <LastSummaryText>
            {t('totalSupplyIs')} {b(amountFormatter(totalPoolTokens, 6, 4))}
          </LastSummaryText>
          <LastSummaryText>
            {t('tokenWorth')} {b(amountFormatter(ethPerLiquidityToken, 6, 4))} TRX {t('and')}{' '}
            {b(amountFormatter(tokenPerLiquidityToken, decimals, Math.min(decimals, 4)))} {symbol}
          </LastSummaryText>
        </>
      )
    }
  }

  function renderSummary() {
    let contextualInfo = ''
    let isError = false
    if (brokenTokenWarning) {
      contextualInfo = t('brokenToken')
      isError = true
    } else if (zeroDecimalError) {
      contextualInfo = zeroDecimalError
    } else if (inputError || outputError) {
      contextualInfo = inputError || outputError
      isError = true
    } else if (!inputCurrency || !outputCurrency) {
      contextualInfo = t('selectTokenCont')
    } else if (!inputValue) {
      contextualInfo = t('enterValueCont')
    } else if (!account) {
      contextualInfo = t('noWallet')
      isError = true
    }

    return (
      <ContextualInfo
        openDetailsText={t('transactionDetails')}
        closeDetailsText={t('hideDetails')}
        contextualInfo={contextualInfo}
        isError={isError}
        renderTransactionDetails={renderTransactionDetails}
      />
    )
  }

  const addTransaction = useTransactionAdder()

  async function onAddLiquidity() {
    // take ETH amount, multiplied by ETH rate and 2 for total tx size
    let ethTransactionSize = (inputValueParsed / 1e6) * 2

    const deadline = Math.ceil(Date.now() / 1000) + DEADLINE_FROM_NOW

    /*
    const estimatedGasLimit = await exchangeContract.estimate.addLiquidity(
      isNewExchange ? ethers.constants.Zero : liquidityTokensMin,
      isNewExchange ? outputValueParsed : outputValueMax,
      deadline,
      {
        value: inputValueParsed
      }
    )

    const gasLimit = calculateGasMargin(estimatedGasLimit, GAS_MARGIN)
    */

    const args = [
      isNewExchange ? ethers.constants.Zero : liquidityTokensMin,
      isNewExchange ? outputValueParsed : outputValueMax,
      deadline
    ]

    const callValue = inputValueParsed
    //console.log({ args, callValue })
    exchangeContract
      .addLiquidity(...args)
      .send({ callValue })
      .then(response => {
        //console.log({ response })
        // log pool added to and total usd amount
        /*
        ReactGA.event({
          category: 'Transaction',
          action: 'Add Liquidity',
          label: outputCurrency,
          value: ethTransactionSize,
          dimension1: response.hash
        })
        ReactGA.event({
          category: 'Hash',
          action: response.hash,
          label: ethTransactionSize.toString()
        })
        */
        addTransaction(response)
      })
  }

  function formatBalance(value) {
    return `Balance: ${value}`
  }

  useEffect(() => {
    setBrokenTokenWarning(false)
    for (let i = 0; i < brokenTokens.length; i++) {
      if (brokenTokens[i].toLowerCase() === outputCurrency.toLowerCase()) {
        setBrokenTokenWarning(true)
      }
    }
  }, [outputCurrency])

  useEffect(() => {
    if (isNewExchange) {
      setZeroDecimalError()
      if (inputValue) {
        const parsedInputValue = ethers.utils.parseUnits(inputValue, 6)
        setInputValueParsed(parsedInputValue)
      }
      if (outputValue) {
        try {
          const parsedOutputValue = ethers.utils.parseUnits(outputValue, decimals)
          //console.log({ parsedOutputValue })
          setOutputValueParsed(parsedOutputValue)
        } catch {
          setZeroDecimalError('Invalid input. For 0 decimal tokens only supply whole number token amounts.')
        }
      }
    }
  }, [decimals, inputValue, isNewExchange, outputValue])

  // parse input value
  useEffect(() => {
    if (
      isNewExchange === false &&
      inputValue &&
      marketRate &&
      lastEditedField === INPUT &&
      (decimals || decimals === 0)
    ) {
      try {
        const parsedValue = ethers.utils.parseUnits(inputValue, 6)

        if (parsedValue.lte(ethers.constants.Zero) || parsedValue.gte(ethers.constants.MaxUint256)) {
          throw Error()
        }

        setInputValueParsed(parsedValue)

        // console.log('marketRate', marketRate.toString())
        // console.log('input', parsedValue.toString())
        // const currencyAmount = marketRate.mul(parsedValue).mul(bigNumberify(10).pow(bigNumberify(6 - decimals)))

 
        let currencyAmount = marketRate.mul(parsedValue)
        currencyAmount = currencyAmount.div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(6)))
        // c/10^6 * 10^decimals <=> c * 10^(decimals - 6)
        currencyAmount = currencyAmount.mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(decimals - 6)))

        /// currencyAmount = currencyAmount.div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(decimals))) // in sTRX
        console.log(currencyAmount.toString())

          // .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(6 - decimals)))

        console.log({inputValue, decimals, parsedValue: parsedValue.toString(), marketRate: marketRate.toString(), currencyAmount: currencyAmount.toString()})
        // console.log('currencyAmount', currencyAmount.toString())
        /*
        const currencyAmount = marketRate
          .mul(parsedValue)
          .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(18)))
          .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(18 - decimals)))
        */

        setOutputValueParsed(currencyAmount)
        dispatchAddLiquidityState({
          type: 'UPDATE_DEPENDENT_VALUE',
          payload: { field: OUTPUT, value: amountFormatter(currencyAmount, decimals, Math.min(decimals, 4), false) }
        })

        return () => {
          setOutputError()
          setInputValueParsed()
          setOutputValueParsed()
          dispatchAddLiquidityState({
            type: 'UPDATE_DEPENDENT_VALUE',
            payload: { field: OUTPUT, value: '' }
          })
        }
      } catch (err) {
        console.error(err)
        setOutputError(t('inputNotValid'))
      }
    }
  }, [inputValue, isNewExchange, lastEditedField, marketRate, decimals, t])

  // parse output value
  useEffect(() => {
    if (
      isNewExchange === false &&
      outputValue &&
      marketRateInverted &&
      lastEditedField === OUTPUT &&
      (decimals || decimals === 0)
    ) {
      try {
        const parsedValue = ethers.utils.parseUnits(outputValue, decimals)

        if (parsedValue.lte(ethers.constants.Zero) || parsedValue.gte(ethers.constants.MaxUint256)) {
          throw Error()
        }

        setOutputValueParsed(parsedValue)

        const currencyAmount = marketRateInverted
          .mul(parsedValue)
          .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(decimals)))

        setInputValueParsed(currencyAmount)
        dispatchAddLiquidityState({
          type: 'UPDATE_DEPENDENT_VALUE',
          payload: { field: INPUT, value: amountFormatter(currencyAmount, 6, 4, false) }
        })

        return () => {
          setInputError()
          setOutputValueParsed()
          setInputValueParsed()
          dispatchAddLiquidityState({
            type: 'UPDATE_DEPENDENT_VALUE',
            payload: { field: INPUT, value: '' }
          })
        }
      } catch {
        setInputError(t('inputNotValid'))
      }
    }
  }, [outputValue, isNewExchange, lastEditedField, marketRateInverted, decimals, t])

  // input validation
  useEffect(() => {
    if (inputValueParsed && inputBalance) {
      if (inputValueParsed.gt(inputBalance)) {
        setInputError(t('insufficientBalance'))
      } else {
        setInputError(null)
      }
    }

    if (outputValueMax && outputBalance) {
      if (outputValueMax.gt(outputBalance)) {
        setOutputError(t('insufficientBalance'))
      } else {
        setOutputError(null)
      }
    }
  }, [inputValueParsed, inputBalance, outputValueMax, outputBalance, t])

  const allowance = useAddressAllowance(account, outputCurrency, exchangeAddress)

  const [showUnlock, setShowUnlock] = useState(false)
  useEffect(() => {
    //console.log({ outputValueParsed, allowance })
    if (outputValueParsed && allowance) {
      if (allowance.lt(outputValueParsed)) {
        setOutputError(t('unlockTokenCont'))
        setShowUnlock(true)
      }
      return () => {
        setOutputError()
        setShowUnlock(false)
      }
    }
  }, [outputValueParsed, allowance, t])

  const isActive = active && account
  const isValid =
    (inputError === null || outputError === null) && !zeroDecimalError && !showUnlock && !brokenTokenWarning

  const newOutputDetected =
    outputCurrency !== 'TRX' && outputCurrency && !INITIAL_TOKENS_CONTEXT[chainId].hasOwnProperty(outputCurrency)

  const [showOutputWarning, setShowOutputWarning] = useState(false)

  useEffect(() => {
    if (newOutputDetected) {
      setShowOutputWarning(true)
    } else {
      setShowOutputWarning(false)
    }
  }, [newOutputDetected, setShowOutputWarning])
    console.log({outputValue})
  return (
    <>
      {showOutputWarning && (
        <WarningCard
          onDismiss={() => {
            setShowOutputWarning(false)
          }}
          urlAddedTokens={urlAddedTokens}
          currency={outputCurrency}
        />
      )}
      <CurrencyInputPanel
        title={t('deposit')}
        extraText={inputBalance && formatBalance(amountFormatter(inputBalance, 6, 4))}
        onValueChange={inputValue => {
          dispatchAddLiquidityState({ type: 'UPDATE_VALUE', payload: { value: inputValue, field: INPUT } })
        }}
        extraTextClickHander={() => {
          if (inputBalance) {
            // TODO: fix this math to match 6 decimals.. parseTron ?
            const valueToSet = inputBalance.sub(ethers.utils.bigNumberify(100000))
            if (valueToSet.gt(ethers.constants.Zero)) {
              dispatchAddLiquidityState({
                type: 'UPDATE_VALUE',
                payload: { value: amountFormatter(valueToSet, 6, 6, false), field: INPUT }
              })
            }
          }
        }}
        selectedTokenAddress="TRX"
        value={inputValue}
        errorMessage={inputError}
        disableTokenSelect
      />
      <OversizedPanel>
        <DownArrowBackground>
          <ColoredWrappedPlus active={isActive} alt="plus" />
        </DownArrowBackground>
      </OversizedPanel>
      <CurrencyInputPanel
        title={t('deposit')}
        description={isNewExchange ? '' : outputValue ? `(${t('estimated')})` : ''}
        extraText={
          outputBalance && decimals && formatBalance(amountFormatter(outputBalance, decimals, Math.min(decimals, 4)))
        }
        urlAddedTokens={urlAddedTokens}
        selectedTokenAddress={outputCurrency}
        onCurrencySelected={outputCurrency => {
          dispatchAddLiquidityState({ type: 'SELECT_CURRENCY', payload: outputCurrency })
        }}
        onValueChange={outputValue => {
          console.log({outputValue})
          dispatchAddLiquidityState({ type: 'UPDATE_VALUE', payload: { value: outputValue, field: OUTPUT } })
        }}
        extraTextClickHander={() => {
          if (outputBalance) {
            dispatchAddLiquidityState({
              type: 'UPDATE_VALUE',
              payload: {
                value: amountFormatter(calculateMaxOutputVal(outputBalance), decimals, decimals, false),
                field: OUTPUT
              }
            })
          }
        }}
        value={outputValue}
        showUnlock={showUnlock}
        errorMessage={outputError}
      />
      <OversizedPanel hideBottom>
        <SummaryPanel>
          <ExchangeRateWrapper>
            <ExchangeRate>{t('exchangeRate')}</ExchangeRate>
            <span>{marketRate ? `1 TRX = ${amountFormatter(marketRate, 6, 4)} ${symbol}` : ' - '}</span>
          </ExchangeRateWrapper>
          <ExchangeRateWrapper>
            <ExchangeRate>{t('currentPoolSize')}</ExchangeRate>
            <span>
              {exchangeETHBalance && exchangeTokenBalance
                ? `${amountFormatter(exchangeETHBalance, 6, 4)} TRX + ${amountFormatter(
                    exchangeTokenBalance,
                    decimals,
                    Math.min(4, decimals)
                  )} ${symbol}`
                : ' - '}
            </span>
          </ExchangeRateWrapper>
          <ExchangeRateWrapper>
            <ExchangeRate>
              {t('yourPoolShare')} ({exchangeETHBalance && amountFormatter(poolTokenPercentage, 16, 2)}%)
            </ExchangeRate>
            <span>
              {ethShare && tokenShare
                ? `${amountFormatter(ethShare, 6, 4)} TRX + ${amountFormatter(
                    tokenShare,
                    decimals,
                    Math.min(4, decimals)
                  )} ${symbol}`
                : ' - '}
            </span>
          </ExchangeRateWrapper>
        </SummaryPanel>
      </OversizedPanel>
      {renderSummary()}
      {isNewExchange ? (
        <NewExchangeWarning>
          <NewExchangeWarningText>
            <span role="img" aria-label="first-liquidity">
              🚰
            </span>{' '}
            {t('firstLiquidity')}
          </NewExchangeWarningText>
          <NewExchangeWarningText style={{ marginTop: '10px' }}>
            {t('initialExchangeRate', { symbol })}
          </NewExchangeWarningText>
        </NewExchangeWarning>
      ) : null}
      {isNewExchange && (
        <NewExchangeWarningText style={{ textAlign: 'center', marginTop: '10px' }}>
          {t('initialWarning')}
        </NewExchangeWarningText>
      )}
      <Flex>
        <Button disabled={!isValid} onClick={onAddLiquidity}>
          {t('addLiquidity')}
        </Button>
      </Flex>
    </>
  )
}
