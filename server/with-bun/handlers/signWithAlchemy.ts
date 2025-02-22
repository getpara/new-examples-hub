import { Para as ParaServer, hexStringToBase64, Environment } from "@getpara/server-sdk";
import type { SuccessfulSignatureRes } from "@getpara/server-sdk";
import { simulateVerifyToken } from "../utils/auth-utils";
import { decrypt } from "../utils/encryption-utils";
import { getKeyShareInDB } from "../db/keySharesDB";
import { createParaAccount, createParaViemClient } from "@getpara/viem-v2-integration";
import { http, encodeFunctionData, hashMessage } from "viem";
import type { WalletClient, LocalAccount, SignableMessage, Hash, Chain } from "viem";
import { createModularAccountAlchemyClient } from "@alchemy/aa-alchemy";
import { WalletClientSigner, arbitrumSepolia } from "@alchemy/aa-core";
import Example from "../artifacts/Example.json";
import type { BatchUserOperationCallData, SendUserOperationResult } from "@alchemy/aa-core";

const EXAMPLE_CONTRACT_ADDRESS = "0x7920b6d8b07f0b9a3b96f238c64e022278db1419";

/**
 * Handles signing using Alchemy and Para SDK.
 *
 * @param {Request} req - The incoming request object.
 * @returns {Promise<Response>} - The response containing the user operation result.
 */
export const signWithAlchemy = async (req: Request): Promise<Response> => {
  // Extract and validate Authorization header
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Use your own token verification logic here
  const token = authHeader.split(" ")[1];
  const user = simulateVerifyToken(token);

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse and validate request body
  const { email }: RequestBody = await req.json();

  if (!email) {
    return new Response("Email is required", { status: 400 });
  }

  if (user.email !== email) {
    return new Response("Forbidden", { status: 403 });
  }

  // Ensure environment variables are set
  const PARA_API_KEY = Bun.env.PARA_API_KEY;
  const ALCHEMY_API_KEY = Bun.env.ALCHEMY_API_KEY;
  const ALCHEMY_GAS_POLICY_ID = Bun.env.ALCHEMY_GAS_POLICY_ID;

  if (!PARA_API_KEY) {
    return new Response("PARA_API_KEY not set", { status: 500 });
  }

  if (!ALCHEMY_API_KEY || !ALCHEMY_GAS_POLICY_ID) {
    return new Response("ALCHEMY_API_KEY or ALCHEMY_GAS_POLICY_ID not set", { status: 500 });
  }

  // Initialize Para client and check wallet existence
  const para = new ParaServer(Environment.BETA, PARA_API_KEY);
  const hasPregenWallet = await para.hasPregenWallet({ pregenIdentifier: email, pregenIdentifierType: "EMAIL" });
  if (!hasPregenWallet) {
    return new Response("Wallet does not exist", { status: 400 });
  }

  // Retrieve and decrypt key share
  const keyShare = getKeyShareInDB(email);
  if (!keyShare) {
    return new Response("Key share does not exist", { status: 400 });
  }

  const decryptedKeyShare = decrypt(keyShare);
  await para.setUserShare(decryptedKeyShare);

  // Create viem para account and client
  const viemParaAccount: LocalAccount = await createParaAccount(para);
  const viemClient: WalletClient = createParaViemClient(para, {
    account: viemParaAccount,
    chain: arbitrumSepolia as Chain,
    transport: http("https://ethereum-sepolia-rpc.publicnode.com"),
  });

  // Override the default signMessage method to fix the v value of the signature (necessary for UserOp validity)
  viemClient.signMessage = async ({ message }: { message: SignableMessage }): Promise<Hash> => {
    return customSignMessage(para, message);
  };

  const walletClientSigner: WalletClientSigner = new WalletClientSigner(viemClient, "para");

  // Initialize the Alchemy client
  const alchemyClient = await createModularAccountAlchemyClient({
    apiKey: ALCHEMY_API_KEY,
    chain: arbitrumSepolia,
    signer: walletClientSigner,
    gasManagerConfig: {
      policyId: ALCHEMY_GAS_POLICY_ID,
    },
  });

  // Example batch user operations
  const demoUserOperations: BatchUserOperationCallData = [1, 2, 3, 4, 5].map((x) => ({
    target: EXAMPLE_CONTRACT_ADDRESS,
    data: encodeFunctionData({
      abi: Example.contracts["contracts/Example.sol:Example"].abi,
      functionName: "changeX",
      args: [x],
    }),
  }));

  // Execute user operation via Alchemy client
  const userOperationResult: SendUserOperationResult = await alchemyClient.sendUserOperation({
    uo: demoUserOperations,
  });

  return new Response(JSON.stringify({ route: "signWithAlchemy", userOperationResult }), { status: 200 });
};

/**
 * Custom signMessage method to fix the v value of the signature.
 *
 * @param {ParaServer} para - Para server instance.
 * @param {SignableMessage} message - The message to sign.
 * @returns {Promise<Hash>} - The signed hash.
 */
async function customSignMessage(para: ParaServer, message: SignableMessage): Promise<Hash> {
  const hashedMessage = hashMessage(message);
  const res = await para.signMessage({
    walletId: Object.values(para.wallets!)[0]!.id,
    messageBase64: hexStringToBase64(hashedMessage),
  });

  let signature = (res as SuccessfulSignatureRes).signature;

  // Adjust the v value of the signature if necessary
  const lastByte = parseInt(signature.slice(-2), 16);
  if (lastByte < 27) {
    const adjustedV = (lastByte + 27).toString(16).padStart(2, "0");
    signature = signature.slice(0, -2) + adjustedV;
  }

  return `0x${signature}`;
}
