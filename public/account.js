// "My account" pieces shared by the customer app, the vendor page and the technician/admin portal.
//   AccountUI.mountSecurity(el, { api, canDelete, onTokenChange(token), onDeleted() })  change password + delete my account
//   AccountUI.mountDetails(el, { api, user, onSaved(user) })  edit name, contact details and business details (vendors and technicians)
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function mountSecurity(el, { api, canDelete = true, onTokenChange, onDeleted }) {
    el.innerHTML =
      '<section class="acct-block"><h3>Change password</h3>' +
      '<form id="acct-pw-form" novalidate>' +
        '<label for="acct-cur">Current password</label><input id="acct-cur" type="password" autocomplete="current-password">' +
        '<label for="acct-new">New password (at least 8 characters)</label><input id="acct-new" type="password" autocomplete="new-password">' +
        '<label for="acct-new2">Type the new password again</label><input id="acct-new2" type="password" autocomplete="new-password">' +
        '<button class="btn" id="acct-pw-save" type="submit">Change password</button> <span class="acct-status" id="acct-pw-status" role="status"></span>' +
        '<p class="error" id="acct-pw-error" role="alert"></p></form></section>' +
      (canDelete ? '<section class="acct-block"><h3>Delete my account</h3>' +
        '<p class="acct-note">This removes your name, contact details and photos. Records other people need (like a technician\'s earnings) stay, without your details. It cannot be undone. Anything still in progress must be finished or cancelled first.</p>' +
        '<button class="btn danger" id="acct-del-open" type="button">Delete my account</button>' +
        '<form id="acct-del-form" hidden novalidate><label for="acct-del-pw">Enter your password to confirm</label><input id="acct-del-pw" type="password" autocomplete="current-password">' +
        '<button class="btn danger" id="acct-del-go" type="submit">Yes, delete my account</button> <button class="btn ghost" id="acct-del-no" type="button">Keep my account</button>' +
        '<p class="error" id="acct-del-error" role="alert"></p></form></section>' : '');
    const $ = id => el.querySelector('#' + id);

    $('acct-pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('acct-pw-error').textContent = ''; $('acct-pw-status').textContent = '';
      if ($('acct-new').value !== $('acct-new2').value) { $('acct-pw-error').textContent = 'The two new passwords do not match.'; return; }
      $('acct-pw-save').disabled = true;
      try {
        const r = await api('/auth/change-password', { method: 'POST', body: { current: $('acct-cur').value, password: $('acct-new').value } });
        if (r.token) { try { localStorage.setItem('authToken', r.token); } catch (_) {} if (onTokenChange) onTokenChange(r.token); }
        $('acct-pw-form').reset();
        $('acct-pw-status').textContent = 'Password changed. You were signed out of your other devices.';
      } catch (err) { $('acct-pw-error').textContent = err.message; }
      finally { $('acct-pw-save').disabled = false; }
    });

    if (canDelete) {
      $('acct-del-open').addEventListener('click', () => { $('acct-del-form').hidden = false; $('acct-del-open').hidden = true; $('acct-del-pw').focus(); });
      $('acct-del-no').addEventListener('click', () => { $('acct-del-form').hidden = true; $('acct-del-open').hidden = false; $('acct-del-error').textContent = ''; $('acct-del-pw').value = ''; });
      $('acct-del-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        $('acct-del-error').textContent = '';
        if (!confirm('Delete your account for good? This cannot be undone.')) return;
        $('acct-del-go').disabled = true;
        try {
          await api('/auth/delete-account', { method: 'POST', body: { password: $('acct-del-pw').value } });
          try { localStorage.removeItem('authToken'); } catch (_) {}
          if (onDeleted) onDeleted(); else location.replace('/');
        } catch (err) { $('acct-del-error').textContent = err.message; $('acct-del-go').disabled = false; }
      });
    }
  }

  async function mountDetails(el, { api, user, onSaved }) {
    const isVendor = user.role === 'vendor', isStaff = user.role === 'staff', isAdmin = user.role === 'admin';
    const [parishes, specialties] = await Promise.all([api('/auth/parishes'), isStaff ? api('/auth/specialties') : Promise.resolve([])]);
    el.innerHTML =
      '<section class="acct-block"><h3>' + (isVendor || isStaff ? 'Your details' : 'My details') + '</h3>' +
      '<form id="acct-form" novalidate>' +
        '<label for="ac-name">' + (isVendor || isStaff ? 'Contact name' : 'Name') + '</label><input id="ac-name" maxlength="80" value="' + esc(user.name) + '">' +
        ((isVendor || isStaff) ? '<label for="ac-biz">Business name' + (isStaff ? ' (optional)' : '') + '</label><input id="ac-biz" maxlength="100" value="' + esc(user.businessName) + '">' : '') +
        '<div class="row"><div><label for="ac-phone">Phone number</label><input id="ac-phone" type="tel" value="' + esc(user.phone) + '" placeholder="876-555-0123"></div>' +
        '<div><label for="ac-parish">Parish</label><select id="ac-parish"><option value="">' + (isAdmin ? 'Not set' : 'Choose your parish') + '</option>' + parishes.map(p => '<option' + (p === user.parish ? ' selected' : '') + '>' + esc(p) + '</option>').join('') + '</select></div></div>' +
        '<label for="ac-address">' + (isVendor ? 'Address (customers collect from here)' : 'Address') + '</label><textarea id="ac-address" rows="2" maxlength="200" placeholder="Street, community or town">' + esc(user.address) + '</textarea>' +
        (isStaff ? '<label>The work you do</label><div class="checks acct-checks" id="ac-spec">' + specialties.map(s => '<label><input type="checkbox" value="' + esc(s.value) + '"' + (user.specialties.includes(s.value) ? ' checked' : '') + '> ' + esc(s.label) + '</label>').join('') + '</div>' : '') +
        (isStaff ? '<label for="ac-payout">How should we pay you? (bank name, account number, account name)</label><textarea id="ac-payout" rows="2" maxlength="400" placeholder="e.g. NCB, 123456789, Jane Brown. Used to pay you for jobs customers paid for online.">' + esc(user.payoutDetails || '') + '</textarea>' : '') +
        ((isVendor || isStaff) ? '<label for="ac-about">' + (isVendor ? 'About your business' : 'Your experience and qualifications') + '</label><textarea id="ac-about" rows="3" maxlength="600">' + esc(user.experience) + '</textarea>' : '') +
        '<button class="btn" id="ac-save" type="submit">Save changes</button> <span class="acct-status" id="ac-status" role="status"></span>' +
        '<p class="error" id="ac-error" role="alert"></p></form></section>';
    const $ = id => el.querySelector('#' + id);
    $('acct-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('ac-error').textContent = ''; $('ac-status').textContent = '';
      const body = { name: $('ac-name').value };
      if (!isAdmin || $('ac-phone').value.trim()) body.phone = $('ac-phone').value;
      if (!isAdmin || $('ac-parish').value) body.parish = $('ac-parish').value;
      if (!isAdmin || $('ac-address').value.trim()) body.address = $('ac-address').value;
      if (isVendor || isStaff) { body.businessName = $('ac-biz').value; body.experience = $('ac-about').value; }
      if (isStaff) { body.specialties = [...el.querySelectorAll('#ac-spec input:checked')].map(c => c.value); body.payoutDetails = $('ac-payout').value; }
      $('ac-save').disabled = true;
      try { const r = await api('/auth/profile', { method: 'PATCH', body }); $('ac-status').textContent = 'Saved.'; if (onSaved) onSaved(r.user); }
      catch (err) { $('ac-error').textContent = err.message; }
      finally { $('ac-save').disabled = false; }
    });
  }

  window.AccountUI = { mountSecurity, mountDetails };
})();
