/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log'], function(record, search, log) {

    var ITEM_SUBLIST = 'item';

    // update these ids
    var PARENT_COLUMN_FIELD = 'custcol_parent_item';
    var RELATED_COMPONENT_FIELD = 'custitem_related_components';
    var SPECIAL_VENDOR_FIELD = 'custentity_special_order_vendor';

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            var poId = context.newRecord.id;
            if (!poId) return;

            log.debug('START', 'PO Id: ' + poId);

            var approvalStatus = context.newRecord.getValue({ fieldId: 'approvalstatus' });
            var vendorId = context.newRecord.getValue({ fieldId: 'entity' });

            log.debug('PO Header', {
                poId: poId,
                approvalStatus: approvalStatus,
                vendorId: vendorId
            });

            if (String(approvalStatus) !== '1') {
                log.debug('STOP', 'PO is not Pending Approval');
                return;
            }

            if (!vendorId) {
                log.debug('STOP', 'Vendor not found');
                return;
            }

            var vendorLookup = search.lookupFields({
                type: search.Type.VENDOR,
                id: vendorId,
                columns: [SPECIAL_VENDOR_FIELD]
            });

            var isSpecialVendor = vendorLookup[SPECIAL_VENDOR_FIELD] === true;

            log.debug('Vendor Check', {
                vendorId: vendorId,
                isSpecialVendor: isSpecialVendor
            });

            if (!isSpecialVendor) {
                log.debug('STOP', 'Vendor special order checkbox is not checked');
                return;
            }

            var poLineItems = getPoLineItems(context.newRecord);
            if (!poLineItems.length) {
                log.debug('STOP', 'No item lines found');
                return;
            }

            var parentChildJson = getParentChildJson(poLineItems);
            log.debug('Parent Child JSON', JSON.stringify(parentChildJson));

            if (!hasKeys(parentChildJson)) {
                log.debug('STOP', 'No parent-child setup found');
                return;
            }

            var poRec = record.load({
                type: record.Type.PURCHASE_ORDER,
                id: poId,
                isDynamic: false
            });

            var lineCount = poRec.getLineCount({ sublistId: ITEM_SUBLIST });
            var currentParent = '';
            var usedChildMap = {};
            var hasChanges = false;
            var i;

            for (i = 0; i < lineCount; i++) {
                var lineItemId = poRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: i
                });

                var lineRate = poRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'rate',
                    line: i
                });

                lineItemId = lineItemId ? String(lineItemId) : '';
                lineRate = toNumber(lineRate);

                log.debug('Line Check', {
                    line: i,
                    itemId: lineItemId,
                    rate: lineRate,
                    currentParent: currentParent,
                    usedChildMap: JSON.stringify(usedChildMap)
                });

                if (!lineItemId) {
                    currentParent = '';
                    usedChildMap = {};
                    continue;
                }

                // parent = rate 0 and item exists in parent JSON
                if (parentChildJson[lineItemId] && lineRate === 0) {
                    currentParent = lineItemId;
                    usedChildMap = {}; // reset for new parent block

                    clearParentField(poRec, i);

                    log.debug('PARENT FOUND', {
                        line: i,
                        parentItem: currentParent
                    });

                    continue;
                }

                // child validation
                if (currentParent) {
                    var isValidChild = parentChildJson[currentParent] &&
                                       parentChildJson[currentParent][lineItemId] &&
                                       lineRate > 0;

                    if (isValidChild) {
                        // if already used once under same parent, treat as separate item
                        if (usedChildMap[lineItemId]) {
                            currentParent = '';
                            usedChildMap = {};
                            clearParentField(poRec, i);

                            log.debug('SEPARATE ITEM FOUND', {
                                line: i,
                                itemId: lineItemId,
                                reason: 'Same child repeated under same parent block'
                            });

                            continue;
                        }

                        poRec.setSublistValue({
                            sublistId: ITEM_SUBLIST,
                            fieldId: PARENT_COLUMN_FIELD,
                            line: i,
                            value: currentParent
                        });

                        usedChildMap[lineItemId] = true;
                        hasChanges = true;

                        log.debug('CHILD UPDATED', {
                            line: i,
                            childItem: lineItemId,
                            parentItem: currentParent
                        });

                        continue;
                    }

                    currentParent = '';
                    usedChildMap = {};
                    clearParentField(poRec, i);

                    log.debug('CLEAR CURRENT PARENT', {
                        line: i,
                        itemId: lineItemId,
                        reason: 'Not a valid child for current parent'
                    });

                    continue;
                }

                clearParentField(poRec, i);
            }

            if (hasChanges) {
                var savedId = poRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('PO SAVED', 'PO updated successfully: ' + savedId);
            } else {
                log.debug('NO CHANGES', 'No child line needed update');
            }

        } catch (e) {
            log.error({
                title: 'afterSubmit Error',
                details: e
            });
        }
    }

    function getPoLineItems(poRec) {
        var arr = [];
        var itemMap = {};
        var lineCount = poRec.getLineCount({ sublistId: ITEM_SUBLIST });
        var i;

        for (i = 0; i < lineCount; i++) {
            var itemId = poRec.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: 'item',
                line: i
            });

            if (itemId) {
                itemMap[String(itemId)] = true;
            }
        }

        for (var key in itemMap) {
            arr.push(key);
        }

        log.debug('PO Unique Items', JSON.stringify(arr));
        return arr;
    }

    function getParentChildJson(itemIds) {
        var json = {};

        search.create({
            type: search.Type.ITEM,
            filters: [
                ['internalid', 'anyof', itemIds],
                'AND',
                [RELATED_COMPONENT_FIELD, 'isnotempty', '']
            ],
            columns: [
                'internalid',
                RELATED_COMPONENT_FIELD
            ]
        }).run().each(function(result) {
            var parentId = result.getValue({ name: 'internalid' });
            var childValue = result.getValue({ name: RELATED_COMPONENT_FIELD });

            parentId = parentId ? String(parentId) : '';

            if (parentId && childValue) {
                json[parentId] = buildChildObject(childValue);
            }

            log.debug('Parent Search Row', {
                parentId: parentId,
                childValue: childValue
            });

            return true;
        });

        return json;
    }

    function buildChildObject(value) {
        var obj = {};
        if (!value) return obj;

        var arr = String(value).split(',');
        var i;

        for (i = 0; i < arr.length; i++) {
            var childId = String(arr[i]).replace(/\s+/g, '');
            if (childId) {
                obj[childId] = true;
            }
        }

        return obj;
    }

    function clearParentField(poRec, line) {
        try {
            poRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: PARENT_COLUMN_FIELD,
                line: line,
                value: ''
            });
        } catch (e) {}
    }

    function toNumber(val) {
        var num = parseFloat(val);
        return isNaN(num) ? 0 : num;
    }

    function hasKeys(obj) {
        for (var key in obj) {
            return true;
        }
        return false;
    }

    return {
        afterSubmit: afterSubmit
    };
});