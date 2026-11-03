// The two clients share parsing and encoding; adapt validation keys to UI text.
import {parseSafeImport as parse, safeImportTarget as target} from '../../desktop/src/lib/safeTransactionImport';
const errors: Record<string,string> = {
  fileTooLarge:'Safe transaction file exceeds the size limit',
  invalidTransactionFile:'Invalid Safe transaction file',
  invalidRecipient:'Invalid transaction recipient',
  invalidCalldata:'Invalid transaction calldata',
  invalidImportMethod:'Invalid Transaction Builder method or arguments',
  unsupportedImportOperation:'Only CALL transactions are supported in a batch',
  invalidAmount:'Invalid transaction amount',
  invalidImport:'Invalid Safe proposal format',
  wrongNetwork:'Proposal is for another network',
  importSafeRequired:'Open a Safe or enter its address before importing this file',
  wrongImportSafe:'The file names a different Safe account',
};
function readable<T>(action:()=>T):T {
  try {return action();} catch(e) {
    if(e instanceof Error && errors[e.message])throw new Error(errors[e.message]);
    throw e;
  }
}
export const parseSafeImport=(raw:string)=>readable(()=>parse(raw));
export const safeImportTarget=(...args:Parameters<typeof target>)=>readable(()=>target(...args));
